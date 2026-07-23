import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/api';
import { archiveMemoryItem, deleteMemoryItem } from '$lib/server/engine/memory';

export const PATCH: RequestHandler = ({ locals, params }) => {
	requireAdmin(locals);
	archiveMemoryItem(params.id);
	return json({ ok: true });
};

export const DELETE: RequestHandler = ({ locals, params }) => {
	requireAdmin(locals);
	deleteMemoryItem(params.id);
	return json({ ok: true });
};
