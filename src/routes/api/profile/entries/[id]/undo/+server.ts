import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { undoNote } from '$lib/server/profile';

/** The Undo on a "Noted" chip under a reply. */
export const POST: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	if (!undoNote(user.id, params.id)) error(404, 'Entry not found');
	return json({ ok: true });
};
