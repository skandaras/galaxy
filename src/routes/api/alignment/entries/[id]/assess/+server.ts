import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAlignment } from '$lib/server/api';
import { assessEntry } from '$lib/server/engine/alignment';

/** Only ever because somebody pressed Assess. Nothing here runs on a schedule. */
export const POST: RequestHandler = async ({ locals, params }) => {
	const user = requireAlignment(locals);
	return json(await assessEntry(user.id, params.id));
};
