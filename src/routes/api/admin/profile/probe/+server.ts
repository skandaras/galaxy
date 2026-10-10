import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/api';
import { runProbe } from '$lib/server/engine/profile-probe';

/**
 * Ask the everyday questions with the calling admin's own profile in the
 * prompt. Their own: an admin may not run it over someone else's, since the
 * replies quote what intruded.
 */
export const POST: RequestHandler = async ({ locals }) => {
	const admin = requireAdmin(locals);
	return json(await runProbe(admin.id));
};
