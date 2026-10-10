import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { LIMITS, profileView, wipeProfile } from '$lib/server/profile';

export const GET: RequestHandler = ({ locals }) => {
	const user = requireUser(locals);
	return json({ ...profileView(user.id), limits: LIMITS });
};

/** Everything, for this person only. The page asks first, through ask(). */
export const DELETE: RequestHandler = ({ locals }) => {
	const user = requireUser(locals);
	wipeProfile(user.id);
	return json({ ok: true });
};
