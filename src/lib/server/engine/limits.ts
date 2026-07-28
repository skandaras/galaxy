import { env } from '$env/dynamic/private';

function num(name: string, fallback: number): number {
	const raw = env[name] ?? process.env[name];
	const n = raw === undefined || raw === '' ? NaN : Number(raw);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * How long a model call may produce *nothing* before it is treated as stalled.
 *
 * This is deliberately an idle deadline rather than a total one. A coding turn
 * against a large repository legitimately streams for many minutes, and a flat
 * total deadline killed those runs mid-answer while the connection was healthy
 * — the failure looked like "large repos always time out", because only large
 * repos took long enough to hit it.
 */
export const streamIdleTimeoutMs = () => num('STREAM_IDLE_TIMEOUT_MS', 90_000);

/**
 * Backstop for the pathological case the idle timeout cannot catch: a provider
 * that keeps trickling bytes forever without ever finishing.
 */
export const streamTotalTimeoutMs = () => num('STREAM_TOTAL_TIMEOUT_MS', 1_800_000);

/**
 * Ceiling on the tool output carried in one turn's context.
 *
 * Every tool result stays in the message array and is re-sent on each later
 * iteration, so a run that reads twenty files pays for all twenty on every
 * subsequent call. Without a cap the request grows until the provider stalls
 * or rejects it; past this many characters the oldest results are elided.
 */
export const toolOutputBudgetChars = () => num('TOOL_OUTPUT_BUDGET_CHARS', 240_000);

/** Per-call cap on a single tool result, before the cumulative budget applies. */
export const toolResultMaxChars = () => num('TOOL_RESULT_MAX_CHARS', 30_000);
