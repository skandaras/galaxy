import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { history } from '$lib/server/profile';

/** What an entry said before each correction. The page reads this; agents never do. */
export const GET: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	const versions = history(user.id, params.id);
	if (!versions.length) error(404, 'Entry not found');
	return json({ versions });
};
