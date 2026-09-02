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
 *
 * Three minutes rather than the ninety seconds it started at. The watchdog used
 * to be blind to most of what a provider sends (see the `progress` event in
 * providers/types.ts), so the old figure was measuring the wrong thing and
 * cutting healthy runs; now that it measures real silence, the remaining risk is
 * the opposite one — a slow route or a model that buffers its thinking is quiet
 * for a while and has done nothing wrong. Being wrong here is expensive: a
 * timeout throws away the whole leg and every tool result in it.
 */
export const streamIdleTimeoutMs = () => num('STREAM_IDLE_TIMEOUT_MS', 180_000);

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

/**
 * Tool calls from one model round-trip that may run at once.
 *
 * Only tools that declare `parallelSafe` are ever batched (see loop.ts); the
 * cap is here because the coding tools run one throwaway container per call
 * under the docker executor, and an unbounded batch would ask the daemon for
 * as many containers as the model felt like naming.
 */
export const toolConcurrency = () => num('TOOL_CONCURRENCY', 4);

/**
 * Model round-trips one coding turn may take — *not* tool calls, since a round
 * can carry several. A model that calls one tool at a time spends these fast:
 * a dozen file reads, a few edits and a test run left the old cap of 24 with
 * nothing in hand at the point it should have been committing.
 */
export const codingMaxSteps = () => num('CODING_MAX_STEPS', 50);

/**
 * Model round-trips the explore sub-agent may take before it must answer.
 *
 * Deliberately small. A sub-agent earns its keep by returning an answer instead
 * of a transcript; one that wanders for fifty steps has spent more than the
 * reading it saved, and the honest failure is "I could not establish that in
 * the budget I had".
 */
export const exploreMaxSteps = () => num('EXPLORE_MAX_STEPS', 12);

/**
 * Model round-trips one chat turn may take. Six was hardcoded, which is two
 * pages read and an answer — a question needing four sources ran out with
 * nothing to show. Raising it helps, but the real economy is that a round-trip
 * can carry many tool calls at once; see the turn-budget note in loop.ts.
 */
export const chatMaxSteps = () => num('CHAT_MAX_STEPS', 12);

/**
 * Searches a research round may have in flight at once.
 *
 * Rounds used to fire every query simultaneously, and each one fans out across
 * every enabled engine — three queries against six engines is eighteen
 * near-simultaneous requests from one address, then the next round straight
 * after. "Too many requests" and "unusual traffic from your network" are
 * measuring exactly that, and no amount of dressing up the request fixes a
 * pattern no browser produces.
 */
export const searchConcurrency = () => num('SEARCH_CONCURRENCY', 3);

/**
 * Pages one research round may fetch at once.
 *
 * Same reasoning as `searchConcurrency`, one step further down the pipeline:
 * a round that opens ten pages simultaneously is ten near-simultaneous requests
 * from one address, and unlike the search engines these are the sites the answer
 * will actually rest on — the ones it can least afford to be blocked by.
 */
export const pageReadConcurrency = () => num('PAGE_READ_CONCURRENCY', 3);

/**
 * Gap between searches once a provider has said it is being asked too often.
 *
 * Deliberately slow: by the time this engages an engine has already refused,
 * and SearXNG benches a blocked engine for minutes to an hour, so hurrying only
 * spends searches on engines that are still out.
 */
export const searchThrottledGapMs = () => num('SEARCH_THROTTLED_GAP_MS', 2_000);

/**
 * Gap between searches against a provider whose rate limit is published rather
 * than discovered. Brave's free tier is the case this exists for.
 */
export const searchProviderGapMs = () => num('SEARCH_PROVIDER_GAP_MS', 1_200);
