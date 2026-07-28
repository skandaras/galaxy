import { randomUUID } from 'node:crypto';
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
	/** Called once with the final assistant text after a successful run. */
	onDone: (text: string, usage: Usage | null, choice: ModelChoice) => string | void;
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

	for (let iteration = 0; iteration < opts.maxIterations; iteration++) {
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

		assistantText += iterationText;
		if (!toolCalls.length) break;
		// Stop before spending money on a toolchain the user has abandoned.
		if (job.controller.signal.aborted) break;

		messages.push({ role: 'assistant', content: iterationText, tool_calls: toolCalls });
		for (const call of toolCalls) {
			// Checked per call, so a long chain doesn't have to drain first.
			if (job.controller.signal.aborted) break;
			const tool = toolByName.get(call.name);
			const result = await executeToolCall(opts, call, tool);
			messages.push({ role: 'tool', content: result, tool_call_id: call.id });
		}
		if (job.controller.signal.aborted) break;

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

	const messageId = opts.onDone(assistantText, usage, choice);
	logUsage(opts, choice.model.modelKey, usage, 'ok', choice);
	emitEvent(
		{
			userId: opts.userId,
			chatId: opts.chatId,
			task: opts.task,
			type: 'job',
			name: `${opts.task}.turn`,
			status: 'ok',
			detail: { jobId: job.id }
		},
		{ persist }
	);
	completeJob(job, messageId || undefined);
}

async function executeToolCall(
	opts: LoopOptions,
	call: ToolCall,
	tool: LoopTool | undefined
): Promise<string> {
	const { job, persist } = opts;
	const args = safeParseArgs(call.arguments);
	const summary = tool?.describe?.(args);
	const started = Date.now();
	pushChunk(job, { type: 'tool', name: call.name, status: 'running', detail: summary });

	if (!tool) {
		pushChunk(job, { type: 'tool', name: call.name, status: 'error', detail: 'unknown tool' });
		return JSON.stringify({ error: `Unknown tool: ${call.name}` });
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
		pushChunk(job, { type: 'tool', name: call.name, status: 'ok', detail: summary });
		return result;
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
		pushChunk(job, { type: 'tool', name: call.name, status: 'error', detail: String(err) });
		return JSON.stringify({ error: String(err) });
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
			chatId: opts.chatId,
			task: opts.task,
			modelKey,
			promptTokens: usage?.promptTokens ?? 0,
			completionTokens: usage?.completionTokens ?? 0,
			costUsd: cost,
			status
		})
		.run();
}
