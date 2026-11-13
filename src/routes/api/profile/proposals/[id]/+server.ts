import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { profileWrite, requireUser } from '$lib/server/api';
import { undoLearned } from '$lib/server/profile';

/**
 * Take back something the learning job wrote, which also stops it being
 * learned again. Someone else's is not found, in the query itself.
 */
export const DELETE: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	return json({ proposal: profileWrite(() => undoLearned(user.id, params.id)) });
};
