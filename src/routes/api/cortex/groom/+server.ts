import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { groomStatus, runCortexGroom } from '$lib/server/engine/cortex-groom';

export const GET: RequestHandler = ({ locals }) => {
	const user = requireUser(locals);
	return json(groomStatus(user.id));
};

export const POST: RequestHandler = async ({ locals }) => {
	const user = requireUser(locals);
	// Runs over the caller's own lattice, never anyone else's.
	return json(await runCortexGroom('manual', user.id));
};
