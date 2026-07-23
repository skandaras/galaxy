import type { RequestHandler } from './$types';
import { requireUser, sseResponse } from '$lib/server/api';
import { subscribeEvents } from '$lib/server/engine/events';

// Live Observatory feed. Admins see everything; other users see their own
// activity only.
export const GET: RequestHandler = ({ locals }) => {
	const user = requireUser(locals);
	return sseResponse(({ send }) => {
		return subscribeEvents((e) => {
			if (user.isAdmin || e.userId === user.id) send(e);
		});
	});
};
