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
	const result = decideProposal(params.id, user.id, status);
	// 404 only when there is genuinely no such row. Everything else is a
	// suggestion that exists and could not be carried out, and it used to answer
	// "No such open suggestion" — which told a person who had just watched a row
	// fail that the row was never there. The suggestion stays open, so the reason
	// is something they can act on.
	if (!result.ok) {
		if (result.reason === 'missing') error(404, 'No such open suggestion');
		error(409, result.reason ?? 'Could not apply that suggestion');
	}
	return json({ ok: true, status });
};
