import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { memoryCap, listMemoryItems, listProposals } from '$lib/server/engine/memory';

// A user's own memory: what is held, and what was already waiting for their
// approval when Memory stopped learning.
export const GET: RequestHandler = ({ locals }) => {
	const user = requireUser(locals);
	return json({
		items: listMemoryItems(user.id),
		proposals: listProposals(user.id, 'pending'),
		cap: memoryCap()
	});
};
