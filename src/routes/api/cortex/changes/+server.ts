import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { listChanges } from '$lib/server/cortex';

export const GET: RequestHandler = ({ locals, url }) => {
	const user = requireUser(locals);
	const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 500);
	return json(listChanges(user.id, limit));
};
