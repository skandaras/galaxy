import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { profileWrite, requireUser } from '$lib/server/api';
import { decideProposal, KINDS, type Kind } from '$lib/server/profile';

/**
 * Approve or turn down something the learning job proposed, optionally
 * reworded, moved or given another kind first. Someone else's proposal is not
 * found, in the query itself.
 */
export const POST: RequestHandler = async ({ locals, params, request }) => {
	const user = requireUser(locals);
	const body = await request.json().catch(() => ({}));
	if (typeof body.approve !== 'boolean') error(400, 'approve must be a boolean');
	const edits = {
		claim: typeof body.claim === 'string' ? body.claim : undefined,
		path: typeof body.path === 'string' ? body.path : undefined,
		kind: (KINDS as readonly string[]).includes(body.kind) ? (body.kind as Kind) : undefined
	};
	const proposal = profileWrite(() => decideProposal(user.id, params.id, body.approve, edits));
	return json({ proposal });
};
