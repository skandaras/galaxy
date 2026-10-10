import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { startReading } from '$lib/server/engine/profile-learn';

/**
 * Read the caller's past conversations into their queue. Their own only, and
 * nothing held is cleared. Returns once it has started; progress comes back
 * with GET /api/profile/learning.
 */
export const POST: RequestHandler = ({ locals }) => {
	const user = requireUser(locals);
	const result = startReading(user.id);
	if (!result.started) error(409, result.reason ?? 'Could not start reading');
	return json(result);
};
