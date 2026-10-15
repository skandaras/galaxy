import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireCoder } from '$lib/server/api';
import { getSession } from '$lib/server/engine/coding/session';
import { sessionOverview } from '$lib/server/engine/coding/overview';

export const GET: RequestHandler = ({ locals, params }) => {
	const user = requireCoder(locals);
	const session = getSession(params.id, user.id);
	if (!session) error(404, 'Session not found');
	return json(sessionOverview(session, user.id));
};
