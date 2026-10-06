import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { consolidateMemory } from '$lib/server/engine/memory';

/**
 * Propose a tidier memory: merges and removals land in the review queue, and
 * nothing changes until the person approves them.
 *
 * Own memories only, like every other route here: a run reads that user's
 * private observations, so it stays theirs to trigger.
 */
export const POST: RequestHandler = async ({ locals }) => {
	const user = requireUser(locals);
	return json(await consolidateMemory(user.id));
};
