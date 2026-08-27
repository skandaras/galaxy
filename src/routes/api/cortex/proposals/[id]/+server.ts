import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { decideProposal } from '$lib/server/engine/cortex-groom';

export const POST: RequestHandler = async ({ locals, params, request }) => {
	const user = requireUser(locals);
	const body = await request.json().catch(() => ({}));
	const status = body.status === 'actioned' ? 'actioned' : 'discarded';
	// Accepting records the decision; the change itself is made through the
	// normal write path, so an accepted suggestion is an ordinary edit with an
	// ordinary log entry rather than a second way into the lattice.
	if (!decideProposal(params.id, user.id, status)) error(404, 'No such open suggestion');
	return json({ ok: true, status });
};
