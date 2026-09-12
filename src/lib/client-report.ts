import { version } from '$app/environment';
import { createReportLimiter, describeClientError } from '$lib/client-error';

/**
 * The browser end of crash reporting: the bit that needs a `fetch`, a
 * `location` and the build version, kept apart from `client-error.ts` so the
 * shaping and the rate limit can be tested without any of them.
 */
const limiter = createReportLimiter();

export function reportClientError(err: unknown): void {
	try {
		const body = describeClientError(err, location, version);
		if (!limiter.allow(body.name, Date.now())) return;
		// keepalive, so a report survives the reload that usually follows the
		// thing being reported.
		void fetch('/api/client-errors', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
			keepalive: true
		}).catch(() => {
			// An error handler that can fail on its own is worse than none.
		});
	} catch {
		/* likewise */
	}
}
