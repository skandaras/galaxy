import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { listNotifications, markAllRead, toWire, unreadCount } from '$lib/server/notifications';

export const GET: RequestHandler = ({ locals, url }) => {
	const user = requireUser(locals);
	return json({
		notifications: listNotifications(user.id, {
			unreadOnly: url.searchParams.get('unread') === '1',
			limit: Number(url.searchParams.get('limit')) || 50
		}).map(toWire),
		unread: unreadCount(user.id)
	});
};

/** Mark the whole list read — the "clear" the bell offers. */
export const POST: RequestHandler = ({ locals }) => {
	const user = requireUser(locals);
	return json({ read: markAllRead(user.id) });
};
