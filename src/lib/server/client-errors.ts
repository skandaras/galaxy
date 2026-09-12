import { emitEvent } from '$lib/server/engine/events';

/**
 * A browser crash, recorded as an Observatory event.
 *
 * The `events` table already holds a userId, a name, a status and a JSON
 * detail, and the Observatory already draws it — reachable on a phone since the
 * More sheet gained it. So this is a row, not a column: no migration, and
 * nothing for a rollback to trip over.
 */

/** Per user, because the limiter in the browser belongs to a page that may be looping. */
const MAX_PER_WINDOW = 20;
const WINDOW_MS = 60_000;
const recent = new Map<string, number[]>();

const text = (v: unknown, max: number): string =>
	typeof v === 'string' ? v.slice(0, max) : '';

function allow(userId: string, now: number): boolean {
	const times = (recent.get(userId) ?? []).filter((t) => now - t < WINDOW_MS);
	const ok = times.length < MAX_PER_WINDOW;
	if (ok) times.push(now);
	recent.set(userId, times);
	return ok;
}

/**
 * Records one report. Everything is treated as attacker-controlled — it arrives
 * from a browser — so each field is taken by name, coerced, and truncated, and
 * nothing from the body decides where it is stored.
 *
 * `chatId` is never set on these rows and no message text is ever carried. A
 * hidden chat is memory-only by design and its id must not survive in `events`;
 * a crash report having no chat identity at all is the simplest way to keep
 * that true, and `pathname` is sent without its query for the same reason.
 */
export function recordClientError(userId: string, body: unknown, now = Date.now()): boolean {
	const b = (body ?? {}) as Record<string, unknown>;
	const name = text(b.name, 300);
	if (!name || !allow(userId, now)) return false;
	emitEvent({
		userId,
		type: 'client',
		name,
		status: 'error',
		detail: {
			stack: text(b.stack, 4000),
			pathname: text(b.pathname, 200),
			version: text(b.version, 100)
		}
	});
	return true;
}

/** Exported for the test; the window is a minute and tests should not wait one. */
export const CLIENT_ERROR_LIMIT = { MAX_PER_WINDOW, WINDOW_MS };
