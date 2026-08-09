import { randomUUID } from 'node:crypto';
import type { RunStep, RunToolCall } from '$lib/run-timeline';
import { db } from '$lib/server/db';
import { usageLog } from '$lib/server/db/schema';
import type { ModelChoice } from '$lib/server/providers/registry';
import type {
	ChatRequest,
	ProviderAdapter,
	ProviderMessage,
	StreamEvent,
	ToolCall,
	ToolDef,
	Usage
} from '$lib/server/providers/types';
import { isRetryable, StreamTimeoutError } from '$lib/server/providers/types';
import { emitEvent } from './events';
import { completeJob, failJob, isCancellation, pushChunk, type LiveJob } from './jobs';
import { streamIdleTimeoutMs, streamTotalTimeoutMs, toolOutputBudgetChars } from './limits';

const ELIDED = '[earlier tool output dropped to stay within the context budget]';

export interface LoopTool {
	def: ToolDef;
	/**
	 * Execute a call and return the tool-result string handed back to the model.
	 * `report` attaches structured detail (provider used, counts, failover) to
	 * the Observatory event — the model never sees it.
	 */
	execute: (
		args: Record<string, unknown>,
		report?: (meta: Record<string, unknown>) => void
	) => Promise<string>;
	/** Short human-readable summary of a call for traces (e.g. the bash command). */
	describe?: (args: Record<string, unknown>) => string;
}

/**
 * Why the loop stopped.
 *
 * The distinction is the whole point: `exhausted` and `budget` are turns cut
 * short with work possibly unfinished, and used to be indistinguishable from
 * `complete` — the run just ended, status ok, mid-task.
 */
export type StopReason = 'complete' | 'exhausted' | 'cancelled' | 'budget';

/**
 * Defined in `$lib/run-timeline` so the engine, the `trace` column and the two
 * pages that draw a run all read from one definition. Re-exported here under
 * the names the engine has always used.
 *
 * A TurnStep groups the records in `TurnSummary.toolCalls` — it does not copy
 * them. The same objects appear in both, so there is one set of facts about a
 * run, with a flat view for the callers that want every call in order and a
 * nested view for the ones rendering a timeline.
 */
export type ToolCallRecord = RunToolCall;
export type TurnStep = RunStep;

export interface TurnSummary {
	stopReason: StopReason;
	/** Model round-trips used, which is what `maxIterations` actually counts. */
	steps: number;
	toolCalls: ToolCallRecord[];
	/** The same calls, grouped under the step that made them. */
	trace: TurnStep[];
	/**
	 * True when the leg produced no closing prose and the saved message is the
	 * step-label stand-in rather than something the model wrote. The caller uses
	 * this to replace it with a real summary later — and to know it is safe to,
	 * since overwriting an actual reply never would be.
	 */
	fallbackReply: boolean;
}

export interface LoopOptions {
	job: LiveJob;
	task: string;
	userId: string;
	chatId: string;
	persist: boolean;
	primary: ModelChoice;
	backup: ModelChoice | null;
	buildMessages: () => ProviderMessage[];
	tools: LoopTool[];
	maxIterations: number;
	/**
	 * Re-checked every few steps on a long run. `assertBudget` only guards the
	 * start of a turn, which is not enough once turns can run for dozens of
	 * steps and continue automatically.
	 */
	budgetBlocked?: () => boolean;
	/**
	 * Leave the job open when the turn ends, so a caller running several legs
	 * finishes it once at the end rather than completing it per leg.
	 */
	autoComplete?: boolean;
	/** Called once with the final assistant text after a successful run. */
	onDone: (
		text: string,
		usage: Usage | null,
		choice: ModelChoice,
		summary: TurnSummary
	) => string | void;
}

/** How often the budget is re-checked mid-run, in model round-trips. */
const BUDGET_CHECK_EVERY = 4;

/** A step label is a glance, not a sentence to read. */
const STEP_LABEL_MAX = 100;

/**
 * Longest a piece of text can be and still be read as a lead-in rather than
 * something the model wrote for the user.
 *
 * Real narration is one short line — "Reading the loop to see how legs are
 * driven" is 45 characters, and even a wordy one rarely passes 150.
 */
const NARRATION_MAX = 200;

/**
 * Is this iteration's text a line introducing the tools it is about to call,
 * or is it content that happens to be followed by a tool call?
 *
 * The distinction is the whole safety of turning narration into step labels.
 * Asked to redraft an email, a model writes the new draft *and* calls a tool
 * in the same message — and treating that draft as a label threw the user's
 * actual work away, leaving them a reply that only described it.
 *
 * So the test is deliberately mean: anything long, anything with a blank line,
 * anything with a code fence or more than a couple of lines is content. Being
 * wrong that way merely leaves a lead-in sitting in the reply, which is what
 * used to happen to all of them. Being wrong the other way destroys writing.
 */
export function isNarration(text: string): boolean {
	const t = text.trim();
	if (!t) return true; // nothing to lose either way
	if (t.length > NARRATION_MAX) return false;
	if (/\n\s*\n/.test(t)) return false; // more than one paragraph
	if (t.includes('```')) return false; // a code block is never a lead-in
	return t.split('\n').filter((l) => l.trim()).length <= 2;
}

/**
 * Turn the narration a model writes before a batch of tool calls into a label
 * for that step.
 *
 * This text used to be appended to the reply, which is why narration and final
 * answer arrived glued together as one blob. It is far more use as the name of
 * the step it introduces — and it costs nothing, because the model was already
 * writing it.
 *
 * `fallback` covers a model that narrates nothing, which is why the prompt line
 * asking for narration is a nudge rather than a requirement.
 */
export function stepLabel(narration: string, fallback: string): string {
	const firstLine =
		narration
			.trim()
			.split('\n')
			.map((l) => l.trim())
			.find(Boolean) ?? '';
	// Narration commonly opens as a bullet, a heading or a bold lead-in. Those
	// marks are noise on a single line.
	const line = firstLine
		.replace(/^[#>*\-+\s]+/, '')
		.replace(/\*\*/g, '')
		.trim();
	if (!line) return fallback;
	if (line.length <= STEP_LABEL_MAX) return line;
	// Too long for a label: prefer a whole first sentence over a hard cut.
	const sentence = /^.*?[.!?](?=\s|$)/.exec(line)?.[0];
	if (sentence && sentence.length <= STEP_LABEL_MAX) return sentence;
	return `${line.slice(0, STEP_LABEL_MAX - 1).trimEnd()}…`;
}

/** Label for a step the model introduced with nothing: name what it called. */
function describeBatch(calls: ToolCall[], tools: Map<string, LoopTool>): string {
	const first = calls[0];
	const detail = tools.get(first.name)?.describe?.(safeParseArgs(first.arguments)) ?? '';
	const head = detail ? `${first.name} ${detail}` : first.name;
	return calls.length > 1 ? `${head} (+${calls.length - 1} more)` : head;
}

/**
 * What to save when a leg ends with tool calls still in flight and therefore no
 * closing prose of its own.
 *
 * Before intent lines this could not happen — every iteration's text was
 * appended, so something was always there. Now the last iteration's narration
 * has become a step label, and an empty assistant message is a reply the user
 * simply never got.
 *
 * `body` starts as the last step label and is rewritten to the leg summary once
 * that arrives (see driveCodingTurn), which is why this is exported.
 */
export function fallbackReply(stopReason: StopReason, body: string): string {
	const why =
		stopReason === 'cancelled'
			? 'Stopped before finishing.'
			: stopReason === 'budget'
				? 'Stopped by the spend cap before finishing.'
				: 'Ran out of steps before finishing.';
	return `${why}\n\n${body}`;
}

/**
 * The shared agentic loop: stream from the model, execute tool calls, feed
 * results back, repeat. Handles failover (primary → primary retry → backup),
 * event emission, job chunks and usage logging for every task type.
 */
export async function runAgentLoop(opts: LoopOptions): Promise<void> {
	const { job, persist } = opts;
	emitEvent(
		{
			userId: opts.userId,
			chatId: opts.chatId,
			task: opts.task,
			type: 'job',
			name: `${opts.task}.turn`,
			status: 'running',
			detail: { jobId: job.id }
		},
		{ persist }
	);

	const attempts: ModelChoice[] = opts.backup
		? [opts.primary, opts.primary, opts.backup]
		: [opts.primary, opts.primary];
	let lastError: unknown = null;

	for (let attempt = 0; attempt < attempts.length; attempt++) {
		const choice = attempts[attempt];
		if (job.controller.signal.aborted) {
			finishCancelled(opts);
			return;
		}
		if (attempt > 0) {
			const switching = choice !== opts.primary;
			pushChunk(job, {
				type: 'notice',
				text: switching
					? `Switched to backup model ${choice.model.displayName}`
					: `Retrying ${choice.model.displayName}…`
			});
			if (switching) {
				emitEvent(
					{
						userId: opts.userId,
						chatId: opts.chatId,
						task: opts.task,
						type: 'failover',
						name: `${opts.primary.model.modelKey} → ${choice.model.modelKey}`,
						status: 'ok',
						detail: { reason: String(lastError) }
					},
					{ persist }
				);
			}
		}
		try {
			await executeWithModel(opts, choice);
			return;
		} catch (err) {
			lastError = err;
			// A stop is not a failure: retrying, or worse failing over to the
			// backup model, would start fresh work the user just asked to end.
			if (isCancellation(err, job.controller.signal)) {
				finishCancelled(opts);
				return;
			}
			if (!isRetryable(err)) break;
		}
	}

	logUsage(opts, opts.primary.model.modelKey, null, 'error');
	// This event is why a dead turn is diagnosable at all. Without it the run
	// emitted `${task}.turn` as `running` on the way in and nothing on the way
	// out, leaving a row in the Observatory that never resolved and no record of
	// what went wrong.
	//
	// It persists even for a hidden chat, where nothing else does — but stripped
	// to a reason: no chat id, no title, no message text. Knowing *that* a turn
	// failed and *why* is what makes the failure fixable; knowing which
	// conversation it was is exactly what hidden mode promises not to keep.
	emitEvent(
		{
			userId: opts.userId,
			chatId: persist ? opts.chatId : undefined,
			task: opts.task,
			type: 'job',
			name: `${opts.task}.turn`,
			status: 'error',
			detail: persist
				? { jobId: job.id, reason: String(lastError) }
				: { hidden: true, reason: String(lastError) }
		},
		{ persist: true }
	);
	failJob(job, `Model call failed: ${String(lastError)}`);
}

/**
 * Wind down a run stopped before it produced anything. The mid-stream case is
 * handled inside executeWithModel, which keeps the partial reply instead.
 */
function finishCancelled(opts: LoopOptions): void {
	emitEvent(
		{
			userId: opts.userId,
			chatId: opts.chatId,
			task: opts.task,
			type: 'job',
			name: `${opts.task}.turn`,
			status: 'ok',
			detail: { jobId: opts.job.id, cancelled: true }
		},
		{ persist: opts.persist }
	);
	completeJob(opts.job);
}

/**
 * Stream from the provider under an *idle* deadline: the clock restarts on
 * every event, so a long-but-healthy turn runs to completion and only a
 * genuinely silent connection is dropped. A separate absolute ceiling covers
 * a provider that trickles forever without finishing.
 *
 * Aborting with a StreamTimeoutError as the reason matters — fetch rejects
 * with the abort reason, so the loop sees a timeout it can fail over on
 * rather than an AbortError it would mistake for the user pressing stop.
 */
export async function* streamWithIdleTimeout(
	adapter: ProviderAdapter,
	req: ChatRequest,
	jobSignal: AbortSignal
): AsyncGenerator<StreamEvent> {
	const idleMs = streamIdleTimeoutMs();
	const watchdog = new AbortController();
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	const arm = () => {
		clearTimeout(idleTimer);
		idleTimer = setTimeout(
			() =>
				watchdog.abort(
					new StreamTimeoutError(`the model sent nothing for ${Math.round(idleMs / 1000)}s`)
				),
			idleMs
		);
	};
	const totalTimer = setTimeout(
		() => watchdog.abort(new StreamTimeoutError('the model call exceeded its total time limit')),
		streamTotalTimeoutMs()
	);

	arm();
	try {
		for await (const ev of adapter.stream(req, AbortSignal.any([watchdog.signal, jobSignal]))) {
			arm();
			yield ev;
		}
	} finally {
		clearTimeout(idleTimer);
		clearTimeout(totalTimer);
	}
}

/**
 * Keep the tool output carried in this turn under the budget by dropping the
 * oldest results first — they are the ones the model has already acted on.
 *
 * Eliding beats failing: the run continues with the context that still
 * matters, where previously an unbounded transcript grew every request until
 * the call stalled. Returns how many results were dropped.
 */
export function elideOldToolOutput(messages: ProviderMessage[], budget: number): number {
	let total = 0;
	for (const m of messages) if (m.role === 'tool') total += m.content.length;
	if (total <= budget) return 0;

	let dropped = 0;
	for (const m of messages) {
		if (total <= budget) break;
		if (m.role !== 'tool' || m.content === ELIDED) continue;
		total -= m.content.length - ELIDED.length;
		m.content = ELIDED;
		dropped++;
	}
	return dropped;
}

async function executeWithModel(opts: LoopOptions, choice: ModelChoice): Promise<void> {
	const { job, persist } = opts;
	pushChunk(job, { type: 'meta', model: choice.model.displayName });

	const toolDefs: ToolDef[] = choice.model.supportsTools ? opts.tools.map((t) => t.def) : [];
	const toolByName = new Map(opts.tools.map((t) => [t.def.name, t]));
	const messages = opts.buildMessages();

	let assistantText = '';
	let usage: Usage | null = null;
	// Assume the step cap wins; every other exit path below sets its own reason.
	let stopReason: StopReason = 'exhausted';
	let steps = 0;
	const toolCallRecords: ToolCallRecord[] = [];
	const trace: TurnStep[] = [];
	/** Label of the most recent tool-calling step, for the empty-reply fallback. */
	let lastStepLabel = '';

	for (let iteration = 0; iteration < opts.maxIterations; iteration++) {
		// A long run has to keep asking, or it can sail well past the cap that
		// was only checked when the turn started.
		if (iteration > 0 && iteration % BUDGET_CHECK_EVERY === 0 && opts.budgetBlocked?.()) {
			stopReason = 'budget';
			break;
		}
		steps++;
		const started = Date.now();
		let iterationText = '';
		let toolCalls: ToolCall[] = [];

		try {
			const stream = streamWithIdleTimeout(
				choice.adapter,
				{ modelKey: choice.model.modelKey, messages, tools: toolDefs },
				// The user pressing stop drops the provider connection immediately;
				// the idle watchdog inside handles a connection that goes quiet.
				job.controller.signal
			);
			for await (const ev of stream) {
				if (ev.type === 'text') {
					iterationText += ev.delta;
					pushChunk(job, { type: 'delta', text: ev.delta });
				} else if (ev.type === 'tool_calls') {
					toolCalls = ev.calls;
				} else if (ev.type === 'usage') {
					usage = addUsage(usage, ev.usage);
				}
			}
		} catch (err) {
			// A stop lands here mid-stream. Keep whatever was generated and fall
			// through to the normal finish, so the partial reply is saved rather
			// than thrown away by the failure path.
			if (isCancellation(err, job.controller.signal)) {
				assistantText += iterationText;
				stopReason = 'cancelled';
				emitEvent(
					{
						userId: opts.userId,
						chatId: opts.chatId,
						task: opts.task,
						type: 'model.call',
						name: choice.model.modelKey,
						status: 'ok',
						durationMs: Date.now() - started,
						detail: { cancelled: true }
					},
					{ persist }
				);
				break;
			}
			emitEvent(
				{
					userId: opts.userId,
					chatId: opts.chatId,
					task: opts.task,
					type: 'model.call',
					name: choice.model.modelKey,
					status: 'error',
					durationMs: Date.now() - started,
					detail: { error: String(err) }
				},
				{ persist }
			);
			throw err;
		}

		emitEvent(
			{
				userId: opts.userId,
				chatId: opts.chatId,
				task: opts.task,
				type: 'model.call',
				name: choice.model.modelKey,
				status: 'ok',
				durationMs: Date.now() - started,
				detail: usage ? { ...usage } : undefined
			},
			{ persist }
		);

		if (!toolCalls.length) {
			// The model answered instead of calling anything, so it considers the
			// task done — even if it only narrated an edit it never made. This is
			// the only iteration whose text is the reply.
			assistantText += iterationText;
			stopReason = 'complete';
			break;
		}
		// A lead-in introducing the tools about to run becomes this step's label
		// and leaves the reply. Anything more substantial is the model writing
		// for the user — it stays in the reply and the step is named after what
		// it actually called. Either way the model still sees the text: the
		// `messages.push` below is untouched.
		const consumedText = isNarration(iterationText);
		const label = consumedText
			? stepLabel(iterationText, describeBatch(toolCalls, toolByName))
			: describeBatch(toolCalls, toolByName);
		if (!consumedText) assistantText += iterationText;
		lastStepLabel = label;
		// Stop before spending money on a toolchain the user has abandoned.
		if (job.controller.signal.aborted) {
			stopReason = 'cancelled';
			break;
		}

		const stepId = randomUUID();
		const stepCalls: ToolCallRecord[] = [];
		// consumedText tells the browser whether the text it has been streaming
		// just became this label — and so should leave the reply — or is part of
		// the answer and must stay put.
		pushChunk(job, { type: 'step', id: stepId, label, status: 'running', consumedText });

		messages.push({ role: 'assistant', content: iterationText, tool_calls: toolCalls });
		for (const call of toolCalls) {
			// Checked per call, so a long chain doesn't have to drain first.
			if (job.controller.signal.aborted) break;
			const tool = toolByName.get(call.name);
			const args = safeParseArgs(call.arguments);
			// One record, held in both views — the flat list every existing caller
			// reads, and this step's group.
			const record: ToolCallRecord = { name: call.name, summary: tool?.describe?.(args) };
			toolCallRecords.push(record);
			stepCalls.push(record);
			const { output, ok } = await executeToolCall(opts, call, tool, stepId);
			record.status = ok ? 'ok' : 'error';
			messages.push({ role: 'tool', content: output, tool_call_id: call.id });
		}

		// A step is only as good as its calls: one failure leaves the group open
		// in the timeline instead of collapsing it out of sight.
		const stepStatus = stepCalls.some((c) => c.status === 'error') ? 'error' : 'ok';
		pushChunk(job, { type: 'step', id: stepId, label, status: stepStatus, consumedText });
		trace.push({ id: stepId, label, status: stepStatus, toolCalls: stepCalls });

		if (job.controller.signal.aborted) {
			stopReason = 'cancelled';
			break;
		}

		// Tool results are re-sent on every later iteration, so a long run has to
		// shed the oldest ones or its own request eventually stalls the call.
		const dropped = elideOldToolOutput(messages, toolOutputBudgetChars());
		if (dropped) {
			pushChunk(job, {
				type: 'notice',
				text: `Dropped ${dropped} earlier tool result${dropped === 1 ? '' : 's'} to stay within the context budget.`
			});
			emitEvent(
				{
					userId: opts.userId,
					chatId: opts.chatId,
					task: opts.task,
					type: 'job',
					name: `${opts.task}.context.elided`,
					status: 'ok',
					detail: { dropped, iteration }
				},
				{ persist }
			);
		}
	}

	const usedFallback = !assistantText.trim() && !!lastStepLabel;
	const summary: TurnSummary = {
		stopReason,
		steps,
		toolCalls: toolCallRecords,
		trace,
		fallbackReply: usedFallback
	};
	if (stopReason === 'budget') {
		pushChunk(job, {
			type: 'notice',
			text: 'Stopped: the spend cap was reached partway through this run.'
		});
	}
	// A leg cut short mid-toolchain has no closing prose of its own — its last
	// narration became a step label — and saving that as a blank assistant
	// message is a reply the user simply never got. A run that called nothing
	// and still came back empty is left alone: that is a genuine empty answer,
	// and run-history reports it as one (see lastReplyWasEmpty).
	const finalText = usedFallback ? fallbackReply(stopReason, lastStepLabel) : assistantText;
	const messageId = opts.onDone(finalText, usage, choice, summary);
	logUsage(opts, choice.model.modelKey, usage, 'ok', choice);
	emitEvent(
		{
			userId: opts.userId,
			chatId: opts.chatId,
			task: opts.task,
			type: 'job',
			name: `${opts.task}.turn`,
			status: 'ok',
			detail: { jobId: job.id, stopReason, steps }
		},
		{ persist }
	);
	if (opts.autoComplete !== false) completeJob(job, messageId || undefined);
}

/** `ok` is false for a failed call, so its step can be marked failed too. */
async function executeToolCall(
	opts: LoopOptions,
	call: ToolCall,
	tool: LoopTool | undefined,
	stepId: string
): Promise<{ output: string; ok: boolean }> {
	const { job, persist } = opts;
	const args = safeParseArgs(call.arguments);
	const summary = tool?.describe?.(args);
	const started = Date.now();
	/**
	 * callId is the provider's own id for this call, which is what makes a
	 * terminal chunk findable when several calls to one tool are in flight.
	 *
	 * Key order is deliberate and load-bearing: the end-to-end smoke suite —
	 * the gate that decides whether an image is cut — matches raw SSE text for
	 * `"type":"tool","name":"…","status":"ok"`. Building this by spreading a
	 * prefix object put the ids between `name` and `status` and broke seven of
	 * those assertions at once. New fields go on the end.
	 */
	const emit = (status: 'running' | 'ok' | 'error', detail?: string) =>
		pushChunk(job, { type: 'tool', name: call.name, status, detail, callId: call.id, stepId });
	emit('running', summary);

	if (!tool) {
		emit('error', 'unknown tool');
		return { output: JSON.stringify({ error: `Unknown tool: ${call.name}` }), ok: false };
	}
	let meta: Record<string, unknown> = {};
	try {
		const result = await tool.execute(args, (m) => {
			meta = m;
		});
		emitEvent(
			{
				userId: opts.userId,
				chatId: opts.chatId,
				task: opts.task,
				type: 'tool.call',
				name: call.name,
				status: 'ok',
				durationMs: Date.now() - started,
				detail: { summary, resultChars: result.length, ...meta }
			},
			{ persist }
		);
		emit('ok', summary);
		return { output: result, ok: true };
	} catch (err) {
		emitEvent(
			{
				userId: opts.userId,
				chatId: opts.chatId,
				task: opts.task,
				type: 'tool.call',
				name: call.name,
				status: 'error',
				durationMs: Date.now() - started,
				detail: { summary, error: String(err) }
			},
			{ persist }
		);
		emit('error', String(err));
		return { output: JSON.stringify({ error: String(err) }), ok: false };
	}
}

function safeParseArgs(raw: string): Record<string, unknown> {
	try {
		return JSON.parse(raw);
	} catch {
		return {};
	}
}

function addUsage(a: Usage | null, b: Usage): Usage {
	return {
		promptTokens: (a?.promptTokens ?? 0) + b.promptTokens,
		completionTokens: (a?.completionTokens ?? 0) + b.completionTokens
	};
}

function logUsage(
	opts: LoopOptions,
	modelKey: string,
	usage: Usage | null,
	status: 'ok' | 'error',
	choice?: ModelChoice
): void {
	const cost =
		usage && choice?.model.promptCostPerMTok != null && choice.model.completionCostPerMTok != null
			? (usage.promptTokens * choice.model.promptCostPerMTok +
					usage.completionTokens * choice.model.completionCostPerMTok) /
				1_000_000
			: null;
	db.insert(usageLog)
		.values({
			id: randomUUID(),
			ts: new Date(),
			userId: opts.userId,
			// Spend has to be counted whatever the chat was — the budget cap is
			// platform-wide — but a hidden chat's id must not survive here. It was
			// being written unconditionally, which left hidden conversations
			// reconstructable from usage_log by id, timing and cost.
			chatId: opts.persist ? opts.chatId : null,
			task: opts.task,
			modelKey,
			promptTokens: usage?.promptTokens ?? 0,
			completionTokens: usage?.completionTokens ?? 0,
			costUsd: cost,
			status
		})
		.run();
}
