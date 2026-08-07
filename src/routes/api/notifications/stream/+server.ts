import type { RequestHandler } from './$types';
import { requireUser, sseResponse } from '$lib/server/api';
import { subscribeNotifications, subscribeRead } from '$lib/server/notifications';

/**
 * Live notifications for this user's open tabs. Separate from the Observatory
 * feed on purpose: that stream carries what the platform did, this one carries
 * what somebody still has to look at.
 */
export const GET: RequestHandler = ({ locals }) => {
	const user = requireUser(locals);
	return sseResponse(({ send }) => {
		const offNew = subscribeNotifications(user.id, (n) => send({ type: 'new', notification: n }));
		// So a second tab drops its badge when this one reads something.
		const offRead = subscribeRead(user.id, (ids) => send({ type: 'read', ids }));
		return () => {
			offNew();
			offRead();
		};
	});
};
