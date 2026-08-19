import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAlignment } from '$lib/server/api';
import { runAlignmentSynthesis } from '$lib/server/engine/alignment';

export const POST: RequestHandler = async ({ locals }) => {
	const user = requireAlignment(locals);
	return json(await runAlignmentSynthesis('manual', user.id));
};
