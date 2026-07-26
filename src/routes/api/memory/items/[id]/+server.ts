import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { archiveMemoryItem, deleteMemoryItem } from '$lib/server/engine/memory';

// Both mutations are owner-scoped in the query itself. Someone else's item id
// matches no row, so it 404s exactly like a non-existent one — the response
// never reveals that another user's item exists.
export const PATCH: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	if (!archiveMemoryItem(params.id, user.id)) error(404, 'Memory item not found');
	return json({ ok: true });
};

export const DELETE: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	if (!deleteMemoryItem(params.id, user.id)) error(404, 'Memory item not found');
	return json({ ok: true });
};
