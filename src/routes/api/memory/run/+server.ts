import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { runMemory } from '$lib/server/engine/memory';

/** Audit the caller's own activity. Users can only ever run their own. */
export const POST: RequestHandler = async ({ locals }) => {
	const user = requireUser(locals);
	return json(await runMemory('manual', user.id));
};
