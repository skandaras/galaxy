/**
 * What a crash in the browser looks like on the way to being recorded.
 *
 * The app had no client-side error handling of any kind — no hooks.client.ts,
 * no window.onerror, no unhandledrejection, no <svelte:boundary>. A throw
 * inside an effect flush went to a console, and on an installed phone app there
 * is no console. That is how a self-invalidating $effect killed the whole
 * interface twice over without leaving a single line anywhere to read.
 *
 * Shaping and rate limiting live here rather than in hooks.client.ts because
 * they are the parts worth testing, and tests here have no DOM.
 */

/** Stacks are the useful half and the long half; the column is a row in SQLite. */
const STACK_MAX = 4000;
const NAME_MAX = 300;

export interface ClientErrorReport {
	/** The message, which becomes the event's name. */
	name: string;
	stack: string;
	/** Path only — never the query, which carries chat ids. */
	pathname: string;
	/** Build version, so a report can be tied to the code it came from. */
	version: string;
}

/**
 * `pathname` deliberately, not `href`. A chat is addressed as `/chat?chat=<id>`
 * and a hidden chat's id must not survive in `events` — see AGENTS.md. Dropping
 * the query is the whole of that guarantee, so it happens here rather than
 * being left to each caller.
 */
export function describeClientError(
	err: unknown,
	location: { pathname: string },
	version: string
): ClientErrorReport {
	const error = err instanceof Error ? err : null;
	const raw = error ? `${error.name}: ${error.message}` : String(err);
	return {
		name: raw.slice(0, NAME_MAX) || 'Unknown error',
		stack: (error?.stack ?? '').slice(0, STACK_MAX),
		pathname: location.pathname,
		version
	};
}

/** How many reports one page may send, and over what window. */
export const REPORT_MAX = 5;
export const REPORT_WINDOW_MS = 60_000;

/**
 * A render loop throws on every flush, which on a 400ms backdrop tick is a
 * report every 400ms for as long as the tab is open. The first few carry all
 * the information the rest would; the rest are a denial of service on your own
 * database.
 *
 * Keyed by message, so a second, different failure is still reported while the
 * first one is being suppressed.
 */
export function createReportLimiter(max = REPORT_MAX, windowMs = REPORT_WINDOW_MS) {
	const seen = new Map<string, number[]>();
	return {
		allow(name: string, now: number): boolean {
			const times = (seen.get(name) ?? []).filter((t) => now - t < windowMs);
			if (times.length >= max) {
				seen.set(name, times);
				return false;
			}
			times.push(now);
			seen.set(name, times);
			return true;
		}
	};
}
