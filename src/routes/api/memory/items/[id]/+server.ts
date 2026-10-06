import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { archiveMemoryItem, deleteMemoryItem, editMemoryItem } from '$lib/server/engine/memory';

// Every mutation is owner-scoped in the query itself. Someone else's item id
// matches no row, so it 404s exactly like a non-existent one — the response
// never reveals that another user's item exists.
export const PATCH: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	if (!archiveMemoryItem(params.id, user.id)) error(404, 'Memory item not found');
	return json({ ok: true });
};

/** Reword a memory: its title, body or kind. The person's own edit needs no sign-off. */
export const PUT: RequestHandler = async ({ locals, params, request }) => {
	const user = requireUser(locals);
	const body = await request.json().catch(() => ({}));
	const item = editMemoryItem(params.id, user.id, {
		title: body.title,
		content: body.content,
		kind: body.kind
	});
	if (!item) error(404, 'Memory item not found');
	return json({ item });
};

export const DELETE: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	if (!deleteMemoryItem(params.id, user.id)) error(404, 'Memory item not found');
	return json({ ok: true });
};
