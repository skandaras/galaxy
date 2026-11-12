import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/api';
import { runBarCheck } from '$lib/server/engine/profile-bar';

/** Show the learning job twenty messages whose answer is known, and write nothing. */
export const POST: RequestHandler = async ({ locals }) => {
	const admin = requireAdmin(locals);
	return json(await runBarCheck(admin.id));
};
