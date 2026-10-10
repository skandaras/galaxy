import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { runLearning } from '$lib/server/engine/profile-learn';

/** Look through the caller's new conversations now, rather than at the next scheduled run. */
export const POST: RequestHandler = async ({ locals }) => {
	const user = requireUser(locals);
	return json(await runLearning('manual', user.id));
};
