import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { recordClientError } from '$lib/server/client-errors';

/**
 * Where a crash in the browser goes.
 *
 * Nothing on the client had anywhere to report to, so a throw inside an effect
 * flush — which takes the rest of that flush with it and leaves the interface
 * painted but inert — was only ever visible in a console. Installed on a phone
 * there is no console, which is how the same fault survived two rounds of
 * looking for it.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
	const user = requireUser(locals);
	const body = await request.json().catch(() => null);
	recordClientError(user.id, body);
	// 204 and nothing else — a bare Response, because json() would write a body
	// and a 204 may not carry one. The client is already in trouble; there is no
	// answer here it could usefully act on, and a body it might try to parse is
	// one more thing to throw inside an error handler.
	return new Response(null, { status: 204 });
};
