import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAlignment } from '$lib/server/api';
import { principleStats } from '$lib/server/alignment';

/** The track record shown in the editor before anything is changed. */
export const GET: RequestHandler = ({ locals, params }) => {
	const user = requireAlignment(locals);
	return json(principleStats(user.id, params.id));
};
