import { reasoningFor } from '$lib/server/providers/registry';
import { getBudgetStatus } from './budget';
import { getTaskConfig, pickModel } from './engine';
import { emitEvent } from './events';
import type { TurnSummary } from './loop';
import { logUsage } from './usage';

/**
 * Generous for a one-line answer, because a reasoning model spends this budget
 * thinking before it writes anything — the same starvation that made chat
 * titles come back empty at 32 tokens (see chat-title.ts).
 */
const SUMMARY_MAX_TOKENS = 256;
const SUMMARY_TIMEOUT_MS = 20_000;
const MAX_SUMMARY_CHARS = 120;
/** Enough calls to characterise a leg; a 50-step leg does not need all 50. */
const MAX_CALLS_LISTED = 30;

/**
 * Describe one leg to the summariser.
 *
 * Deliberately built from the TurnSummary rather than the transcript: the
 * transcript is the expensive thing, it is the reason a per-leg summary could
 * never be cheap, and the tool calls already say what the leg did. Exported so
 * the shape is testable without a model.
 */
export function formatLegForSummary(summary: TurnSummary): string {
	const ended =
		summary.stopReason === 'complete'
			? 'the agent said it was finished'
			: summary.stopReason === 'exhausted'
				? 'it ran out of steps with work outstanding'
				: summary.stopReason === 'budget'
					? 'the spend cap cut it off'
					: 'the user stopped it';

	const calls = summary.toolCalls.slice(-MAX_CALLS_LISTED);
	const dropped = summary.toolCalls.length - calls.length;
	const lines = calls.map((c) => `- ${c.name}${c.summary ? `: ${c.summary}` : ''}`);
	if (dropped > 0) lines.unshift(`(${dropped} earlier calls omitted)`);

	return [
		`RUN-SUMMARY: Summarise this agent run in one line.`,
		`It took ${summary.steps} model step${summary.steps === 1 ? '' : 's'} and ended because ${ended}.`,
		lines.length ? `--- TOOL CALLS ---\n${lines.join('\n')}` : '(no tools were called)'
	].join('\n\n');
}

/**
 * One line saying what a leg did, from a cheap model chosen in Admin.
 *
 * Best-effort by construction: every failure path returns null and the caller
 * keeps the labels it already derived from describe(). A run must never fail,
 * or stall, because the thing that names it was slow.
 */
export async function summariseLeg(opts: {
	chatId: string;
	userId: string;
	persist: boolean;
	summary: TurnSummary;
}): Promise<string | null> {
	/**
	 * Record why a leg went unsummarised. Every one of these would otherwise be
	 * a silent `return null` — the same defect chat titles had, where an
	 * intermittent failure looked exactly like a feature nobody had enabled.
	 */
	const skip = (reason: string): null => {
		emitEvent(
			{
				userId: opts.userId,
				chatId: opts.persist ? opts.chatId : undefined,
				task: 'run-summary',
				type: 'job',
				name: 'run-summary.skipped',
				status: 'ok',
				detail: { reason }
			},
			{ persist: opts.persist }
		);
		return null;
	};

	if (getBudgetStatus().blocked) return skip('budget cap reached');
	const cfg = getTaskConfig('run-summary');
	const choice = pickModel(cfg?.primaryModelId ?? null);
	if (!choice) return skip('no model configured');

	const started = Date.now();
	try {
		const { text, usage } = await choice.adapter.complete(
			{
				modelKey: choice.model.modelKey,
				messages: [
					{ role: 'system', content: cfg?.systemPrompt ?? '' },
					{ role: 'user', content: formatLegForSummary(opts.summary) }
				],
				maxTokens: SUMMARY_MAX_TOKENS,
				// Reads what it was given and emits a short structured answer, which is
				// the class of task where deliberation buys nothing and costs the wall
				// clock. Sent only to models that accept it — see reasoningFor.
				reasoning: reasoningFor(choice, 'low')
			},
			AbortSignal.timeout(SUMMARY_TIMEOUT_MS)
		);
		logUsage('run-summary', choice.model.modelKey, usage, 'ok', opts.userId);

		const line = cleanSummary(text);
		if (!line) return skip(`model returned nothing usable: ${JSON.stringify(text.slice(0, 120))}`);

		emitEvent(
			{
				userId: opts.userId,
				chatId: opts.persist ? opts.chatId : undefined,
				task: 'run-summary',
				type: 'job',
				name: 'run-summary.run',
				status: 'ok',
				durationMs: Date.now() - started,
				detail: { summary: line, stopReason: opts.summary.stopReason }
			},
			{ persist: opts.persist }
		);
		return line;
	} catch (err) {
		logUsage('run-summary', choice.model.modelKey, null, 'error', opts.userId);
		emitEvent(
			{
				userId: opts.userId,
				chatId: opts.persist ? opts.chatId : undefined,
				task: 'run-summary',
				type: 'job',
				name: 'run-summary.run',
				status: 'error',
				durationMs: Date.now() - started,
				detail: { error: String(err) }
			},
			{ persist: opts.persist }
		);
		return null;
	}
}

/**
 * Models asked for "one line, no preamble" still return `"Quoted"`, `Summary:`
 * prefixes, bullet marks and a trailing stop. Same decorations chat titles
 * arrive wearing, and they nest — so strip in a loop rather than a fixed order.
 */
export function cleanSummary(raw: string): string {
	// Bold goes wholesale: this lands in a commit message and a one-line
	// timeline header, neither of which renders markdown.
	let out = (raw.trim().split('\n').find((l) => l.trim()) ?? '').replace(/\*\*/g, '').trim();
	for (let pass = 0; pass < 3; pass++) {
		const before = out;
		out = out.replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, '').trim();
		out = out.replace(/^[-*•#>\s]+/, '').trim();
		out = out.replace(/^(run\s+|leg\s+)?summary\s*[:\-—]\s*/i, '').trim();
		if (out === before) break;
	}
	return out.replace(/[.,;:]+$/, '').trim().slice(0, MAX_SUMMARY_CHARS);
}

/**
 * Wait for a leg summary, but never for long.
 *
 * The commit message wants it and the commit is on the way to finishing the
 * job, so this is the one place that waits at all — everything else uses it
 * after the fact. A slow or wedged summariser degrades to `null` and the
 * caller's existing behaviour, rather than holding a run open.
 */
export function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | null> {
	return Promise.race([
		promise,
		new Promise<null>((resolve) => setTimeout(() => resolve(null), ms).unref?.())
	]);
}
