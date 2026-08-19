import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAlignment } from '$lib/server/api';
import { alignmentStanding } from '$lib/server/alignment-status';

export const GET: RequestHandler = ({ locals }) => {
	const user = requireAlignment(locals);
	return json(alignmentStanding(user.id));
};
