import type { RequestHandler } from './$types';
import { requireUser, sseResponse } from '$lib/server/api';
import { eventVisibleTo, subscribeEvents } from '$lib/server/engine/events';

// Live Observatory feed. Admins see everything that is recorded; other users
// see their own activity only. A hidden chat's events reach its owner alone.
export const GET: RequestHandler = ({ locals }) => {
	const user = requireUser(locals);
	return sseResponse(({ send }) => {
		return subscribeEvents((e) => {
			if (eventVisibleTo(e, user)) send(e);
		});
	});
};
