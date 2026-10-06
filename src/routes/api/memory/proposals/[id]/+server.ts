import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { MemoryDecisionError, decideProposal } from '$lib/server/engine/memory';

/**
 * Approve or reject one proposal, optionally rewording it as it is approved.
 * Owner-scoped in the query: another person's proposal is "not found".
 */
export const POST: RequestHandler = async ({ locals, params, request }) => {
	const user = requireUser(locals);
	const body = await request.json().catch(() => ({}));
	if (typeof body.approve !== 'boolean') error(400, 'approve must be a boolean');
	try {
		const proposal = decideProposal(params.id, user.id, body.approve, {
			title: body.title,
			content: body.content,
			kind: body.kind
		});
		return json({ proposal });
	} catch (err) {
		if (err instanceof MemoryDecisionError) error(err.status, err.message);
		throw err;
	}
};
