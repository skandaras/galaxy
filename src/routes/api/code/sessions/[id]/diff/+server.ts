import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { getSession, sessionDiff } from '$lib/server/engine/coding/session';

export const GET: RequestHandler = async ({ locals, params }) => {
	const user = requireUser(locals);
	const session = getSession(params.id, user.id);
	if (!session) error(404, 'Session not found');
	return new Response(await sessionDiff(session), {
		headers: { 'content-type': 'text/plain; charset=utf-8' }
	});
};
