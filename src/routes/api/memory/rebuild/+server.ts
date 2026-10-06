import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { startRebuild } from '$lib/server/engine/memory';

/**
 * Wipe the caller's memory and read their whole history back into the review
 * queue. Their own only: it reads that person's conversations. Returns once
 * the wipe is done; the reading carries on in the background and its progress
 * comes back with GET /api/memory.
 */
export const POST: RequestHandler = ({ locals }) => {
	const user = requireUser(locals);
	const result = startRebuild(user.id);
	if (!result.started) error(409, result.reason ?? 'Could not start a rebuild');
	return json(result);
};
