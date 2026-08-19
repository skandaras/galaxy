import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAlignment } from '$lib/server/api';
import { listRevisions } from '$lib/server/alignment';

export const GET: RequestHandler = ({ locals, params }) => {
	const user = requireAlignment(locals);
	return json({ revisions: listRevisions(params.id, user.id) });
};
