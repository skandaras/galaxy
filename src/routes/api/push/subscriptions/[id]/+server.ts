import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { deleteSubscription } from '$lib/server/push';

export const DELETE: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	if (!deleteSubscription(params.id, user.id)) error(404, 'No such device');
	return json({ ok: true });
};
