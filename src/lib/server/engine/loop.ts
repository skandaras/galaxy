import { randomUUID } from 'node:crypto';
import type { RunStep, RunToolCall, SearchResultRow } from '$lib/run-timeline';
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
import {
	streamIdleTimeoutMs,
	streamTotalTimeoutMs,
	toolConcurrency,
	toolOutputBudgetChars
} from './limits';

const ELIDED = '[earlier tool output dropped to stay within the context budget]';

/**
 * The one key in a tool's `report` that is not Observatory detail.
 *
 * Everything else reported is folded into the persisted event; this is lifted
 * out and pushed to the browser instead. Twenty search results on every event
 * row would bloat a table nobody queries that way, and the point of the split is
 * that these three audiences want different things: the model gets the tool's
 * return string, the Observatory gets counts and provider names, and the reader
 * gets something to look at.
 */
export interface ToolDisplay {
	/** Rows to draw under the call, rather than compress into its one-line detail. */
	results?: SearchResultRow[];
}

export interface LoopTool {
	def: ToolDef;
	/**
	 * Execute a call and return the tool-result string handed back to the model.
	 * `report` attaches structured detail (provider used, counts, failover) to
	 * the Observatory event — the model never sees it. The reserved `display`
	 * key is the exception: see ToolDisplay.
	 */
	execute: (
		args: Record<string, unknown>,
		report?: (meta: Record<string, unknown>) => void
	) => Promise<string>;
	/** Short human-readable summary of a call for traces (e.g. the bash command). */
	describe?: (args: Record<string, unknown>) => string;
	/**
	 * Safe to run at the same time as other calls in the same batch.
	 *
	 * Opt-in, and deliberately so: the default is that a tool runs alone, in the
	 * order the model asked for it. A tool qualifies only if it neither changes
	 * anything nor carries per-turn state that a concurrent call could race —
	 * which is why `web_search` and `fetch_url`, both of which count a per-turn
	 * allowance and pace themselves against a rate limit, are left sequential
	 * despite being reads.
	 */
	parallelSafe?: boolean;
	/**
	 * Called once before each model round-trip's calls are executed, so a tool
	 * can reset state scoped to one round-trip rather than to the whole turn.
	 *
	 * The per-turn closure a tool is built in (see `webSearchTool`) is the right
	 * home for an allowance that refills per message. It is the wrong home for a
	 * rule about what may happen *between* two model turns, because the closure
	 * cannot see where one round-trip ends and the next begins. This is that seam.
	 */
	beginStep?: () => void;
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

/** Round-trips left when the model is told to start landing the turn. */
const WRAP_UP_AT = 2;

/**
 * What the model is told about its own budget.
 *
 * The turn cap counts *model round-trips*, not tool calls — a single round-trip
 * can carry as many calls as the model asks for, and the loop executes all of
 * them. Nothing said so, so a model fetching one URL per turn spent the whole
 * budget on a handful of pages and stopped with nothing to show. Saying it is
 * worth more than raising the cap.
 */
export function turnBudgetNote(maxIterations: number, hasSearch = false): string {
	return [
		'',
		`[Turn budget: this reply may take up to ${maxIterations} model turns]`,
		'One turn can call several tools at once, and they all run before you are asked again. Batch independent calls — every URL you need, every file you want to read — into a single turn rather than spending a turn on each.',
		// Said only where there is a web_search to say it about, and said here
		// because this note is what the model actually reads: the tool
		// description and the task prompt both already asked for a deliberate
		// search, and both lost to the batching line above. Two instructions
		// that disagree are decided by the loudest, not the most correct.
		...(hasSearch
			? [
					'Searching is the exception, and it is not an economy you are giving up. A search is a question you ask so that its answer can shape the next one, so run one query, read what it returns, and let that decide what you search for next. Two queries written before either has come back are two guesses.'
				]
			: []),
		'If the work will not fit, answer with what you have and say plainly what you could not check.'
	].join('\n');
}

/** Pushed into the transcript near the cap, so it lands rather than stops. */
export function wrapUpNote(left: number): string {
	return `[${left} model turn${left === 1 ? '' : 's'} left in this reply. Make any last tool calls now, in this one turn, then answer with what you have and say what you could not check.]`;
}

/** A step label is a glance, not a sentence to read. */
const STEP_LABEL_MAX = 100;

/**
 * Longest a piece of text can be and still be read as a lead-in rather than
 * something the model wrote for the user.
 *
 * Deliberately loose. This was 200, which made length the discriminator, and a
 * model that narrates in paragraphs — several sentences naming what it is about
 * to read — landed on both sides of it from one leg to the next: some lead-ins
 * became steps and some piled up in the reply, for no reason a reader could
 * see. The bound is now only a backstop against a genuine page of writing.
 */
const NARRATION_MAX = 1_500;

/**
 * Is this iteration's text a line introducing the tools it is about to call,
 * or is it content that happens to be followed by a tool call?
 *
 * The structural tests are what actually separate the two, and they are the
 * ones that matter: a blank line means more than one paragraph, a code fence is
 * never a lead-in, and past a couple of lines this is a document rather than an
 * introduction. Length is the weakest of the signals and is now the last resort.
 *
 * Getting it wrong used to be expensive in one direction: the label keeps 100
 * characters and the rest was dropped, so a draft read as narration was
 * destroyed. It is no longer — the whole text is carried on the step as `note`
 * and shown when the step is opened — which is what lets this be generous.
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
 * The lead-in in full, for the body of the step it named — or nothing, when the
 * label already carries all of it.
 *
 * `stepLabel` takes the first sentence and cuts at 100 characters, which for a
 * one-line lead-in is the whole text. Storing it again would draw it twice in
 * the same step: once as the summary, once underneath.
 */
export function noteFor(narration: string, label: string): string | undefined {
	const text = narration.trim();
	if (!text) return undefined;
	// Compared on the text alone: the label has had its bullet and bold marks
	// stripped, so "- **Reading the loop**" and "Reading the loop" are the same
	// sentence and only one of them should be kept.
	const bare = text.replace(/^[#>*\-+\s]+/, '').replace(/\*\*/g, '').trim();
	return bare === label ? undefined : text;
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
	completeJob(opts.job, undefined, 'cancelled');
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
	// Appended here rather than by each caller: the loop owns the budget, so it
	// is the only thing that can describe it accurately. Only worth saying when
	// there are tools to batch.
	if (toolDefs.length && messages[0]?.role === 'system' && typeof messages[0].content === 'string') {
		messages[0] = {
			...messages[0],
			content:
				messages[0].content +
				turnBudgetNote(
					opts.maxIterations,
					opts.tools.some((t) => t.def.name === 'web_search')
				)
		};
	}

	/**
	 * The reply, one entry per leg that kept its text.
	 *
	 * A list rather than a running string because these are joined with a blank
	 * line: appending them straight onto each other ran one leg's last sentence
	 * into the next leg's first — "…convert correctly.Now the remaining shapes"
	 * — and produced a reply that read as a wall. The browser assembles its copy
	 * the same way; see applyStreamText.
	 */
	const replyParts: string[] = [];
	const keep = (text: string) => {
		if (text.trim()) replyParts.push(text.trim());
	};
	const replyText = () => replyParts.join('\n\n');
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
				{
						modelKey: choice.model.modelKey,
						messages,
						tools: toolDefs,
						cacheMode: choice.model.cacheMode
					},
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
				keep(iterationText);
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
			keep(iterationText);
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
		// The lead-in in full, kept only when the label is a summary of it rather
		// than the whole thing — a one-sentence lead-in would otherwise print
		// twice in the same step.
		const note = consumedText ? noteFor(iterationText, label) : undefined;
		if (!consumedText) keep(iterationText);
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
		pushChunk(job, { type: 'step', id: stepId, label, status: 'running', consumedText, note });

		messages.push({ role: 'assistant', content: iterationText, tool_calls: toolCalls });
		// Round-trip boundary. A tool that limits what one round-trip may do —
		// rather than what one turn may do — learns here that a new one has begun.
		for (const tool of opts.tools) tool.beginStep?.();
		// The prompt tells the model to batch independent calls into one turn,
		// so honour it: consecutive parallel-safe calls run together, and anything
		// else is a barrier that runs alone in the order asked for. Under the
		// docker executor every coding call is a container round-trip, which is
		// what made a batch of ten file reads cost ten of them in series.
		const batches = batchToolCalls(toolCalls, (name) => toolByName.get(name)?.parallelSafe);
		for (const batch of batches) {
			// Checked per batch, and a barrier is a batch of one — so a long chain
			// still doesn't have to drain first.
			if (job.controller.signal.aborted) break;
			// Records are created in call order before anything runs, so the trace
			// reads the way the model wrote it however the batch finishes.
			const prepared = batch.map((call) => {
				const tool = toolByName.get(call.name);
				const args = safeParseArgs(call.arguments);
				// One record, held in both views — the flat list every existing caller
				// reads, and this step's group.
				const record: ToolCallRecord = { name: call.name, summary: tool?.describe?.(args) };
				toolCallRecords.push(record);
				stepCalls.push(record);
				return { call, tool, record };
			});
			const results = await runBounded(prepared, toolConcurrency(), (item) =>
				executeToolCall(opts, item.call, item.tool, stepId)
			);
			// Pushed in call order rather than completion order: a tool message has
			// to line up with the assistant message's tool_calls.
			for (const [i, { call, record }] of prepared.entries()) {
				const { output, ok, display } = results[i];
				record.status = ok ? 'ok' : 'error';
				// Onto the record, so the box survives a reload: the live chunk is gone
				// the moment the job is, and the trace is all a finished reply keeps.
				if (display?.results) record.results = display.results;
				messages.push({ role: 'tool', content: output, tool_call_id: call.id });
			}
		}

		// A step is only as good as its calls: one failure leaves the group open
		// in the timeline instead of collapsing it out of sight.
		const stepStatus = stepCalls.some((c) => c.status === 'error') ? 'error' : 'ok';
		pushChunk(job, { type: 'step', id: stepId, label, status: stepStatus, consumedText, note });
		trace.push({ id: stepId, label, status: stepStatus, toolCalls: stepCalls, note });

		if (job.controller.signal.aborted) {
			stopReason = 'cancelled';
			break;
		}

		// Near the cap, say so. Without this the budget simply runs out mid-chain
		// and the turn ends holding an unfinished answer; with it the model gets
		// one clear chance to land.
		const left = opts.maxIterations - 1 - iteration;
		if (left === WRAP_UP_AT) messages.push({ role: 'user', content: wrapUpNote(left) });

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

	const assistantText = replyText();
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
	// Everything saved must have been streamed. This stand-in was assembled here
	// rather than generated, so without this push the browser — which rebuilds
	// the reply from deltas — has nothing to commit and shows an empty answer
	// until the conversation is re-read. Safe to append: a fallback only happens
	// when assistantText is empty, so the client's buffer is empty too.
	if (usedFallback) pushChunk(job, { type: 'delta', text: finalText });
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
	if (opts.autoComplete !== false) completeJob(job, messageId || undefined, stopReason);
}

/**
 * Split one round-trip's calls into batches that may run together.
 *
 * A run of consecutive parallel-safe calls becomes one batch; anything else
 * gets a batch to itself, which is what keeps the ordering guarantees intact —
 * a write followed by a read of the same file still happens in that order,
 * because the write is a barrier.
 *
 * Exported for tests: these ordering rules are the whole safety of running
 * anything concurrently.
 */
export function batchToolCalls(
	calls: ToolCall[],
	parallelSafe: (name: string) => boolean | undefined
): ToolCall[][] {
	const batches: ToolCall[][] = [];
	let openRun = false;
	for (const call of calls) {
		const safe = parallelSafe(call.name) === true;
		if (safe && openRun) batches[batches.length - 1].push(call);
		else batches.push([call]);
		openRun = safe;
	}
	return batches;
}

/**
 * Run `fn` over `items` with at most `limit` in flight, returning results in
 * input order. `fn` is expected never to reject — executeToolCall reports a
 * failure as a value — so one bad call cannot strand the rest of a batch.
 */
export async function runBounded<T, R>(
	items: T[],
	limit: number,
	fn: (item: T) => Promise<R>
): Promise<R[]> {
	if (items.length <= 1) return items.length ? [await fn(items[0])] : [];
	const out = new Array<R>(items.length);
	let next = 0;
	const worker = async () => {
		for (;;) {
			const i = next++;
			if (i >= items.length) return;
			out[i] = await fn(items[i]);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return out;
}

/** `ok` is false for a failed call, so its step can be marked failed too. */
async function executeToolCall(
	opts: LoopOptions,
	call: ToolCall,
	tool: LoopTool | undefined,
	stepId: string
): Promise<{ output: string; ok: boolean; display?: ToolDisplay }> {
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
	const emit = (status: 'running' | 'ok' | 'error', detail?: string, results?: SearchResultRow[]) =>
		pushChunk(job, {
			type: 'tool',
			name: call.name,
			status,
			detail,
			callId: call.id,
			stepId,
			results
		});
	emit('running', summary);

	if (!tool) {
		emit('error', 'unknown tool');
		return { output: JSON.stringify({ error: `Unknown tool: ${call.name}` }), ok: false };
	}
	let meta: Record<string, unknown> = {};
	let display: ToolDisplay | undefined;
	try {
		const result = await tool.execute(args, (m) => {
			// `display` is the browser's; everything else is the Observatory's.
			const { display: shown, ...rest } = m;
			display = shown as ToolDisplay | undefined;
			meta = rest;
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
		emit('ok', summary, display?.results);
		return { output: result, ok: true, display };
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
	// The cache fields stay absent unless at least one side reported them, so a
	// provider that says nothing about caching is never recorded as a zero-hit
	// — which would read as "caching is on and doing nothing".
	const cached = sumReported(a?.cachedPromptTokens, b.cachedPromptTokens);
	const discount = sumReported(a?.cacheDiscountUsd, b.cacheDiscountUsd);
	return {
		promptTokens: (a?.promptTokens ?? 0) + b.promptTokens,
		completionTokens: (a?.completionTokens ?? 0) + b.completionTokens,
		...(cached !== undefined ? { cachedPromptTokens: cached } : {}),
		...(discount !== undefined ? { cacheDiscountUsd: discount } : {})
	};
}

function sumReported(a: number | undefined, b: number | undefined): number | undefined {
	if (a === undefined && b === undefined) return undefined;
	return (a ?? 0) + (b ?? 0);
}

function logUsage(
	opts: LoopOptions,
	modelKey: string,
	usage: Usage | null,
	status: 'ok' | 'error',
	choice?: ModelChoice
): void {
	const listPrice =
		usage && choice?.model.promptCostPerMTok != null && choice.model.completionCostPerMTok != null
			? (usage.promptTokens * choice.model.promptCostPerMTok +
					usage.completionTokens * choice.model.completionCostPerMTok) /
				1_000_000
			: null;
	// A gateway that prices caching for us knows better than list price does.
	// The discount is signed: negative on the turn that *writes* the cache,
	// because a write costs more than plain input, and positive on later reads.
	const cost =
		listPrice === null
			? null
			: Math.max(0, listPrice - (usage?.cacheDiscountUsd ?? 0));
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
			cachedPromptTokens: usage?.cachedPromptTokens ?? 0,
			costUsd: cost,
			status
		})
		.run();
}
