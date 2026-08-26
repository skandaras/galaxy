import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireCoder } from '$lib/server/api';
import { getSession, sessionDiff } from '$lib/server/engine/coding/session';

export const GET: RequestHandler = async ({ locals, params }) => {
	const user = requireCoder(locals);
	const session = getSession(params.id, user.id);
	if (!session) error(404, 'Session not found');
	return json(await sessionDiff(session));
};
