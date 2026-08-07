import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { markRead } from '$lib/server/notifications';

export const POST: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	// Already read is not an error — the client may have raced another tab.
	if (!markRead(params.id, user.id)) return json({ read: false });
	return json({ read: true });
};

export const DELETE: RequestHandler = ({ locals }) => {
	requireUser(locals);
	// Notifications are pruned by age, not deleted individually; reading is the
	// only state change, so this exists purely to give a clear 405.
	error(405, 'Notifications are cleared by reading them');
};
