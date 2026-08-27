import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import {
	groomStatus,
	runCortexGroom,
	setUserGroomEnabled
} from '$lib/server/engine/cortex-groom';

export const GET: RequestHandler = ({ locals }) => {
	const user = requireUser(locals);
	return json(groomStatus(user.id));
};

export const POST: RequestHandler = async ({ locals, request }) => {
	const user = requireUser(locals);
	const body = await request.json().catch(() => ({}));
	// Two jobs: `harvest` picks up what has been said since last time, `review`
	// reads the whole lattice looking for consolidation. Runs over the caller's
	// own lattice, never anyone else's.
	const mode = body?.mode === 'harvest' ? 'harvest' : 'review';
	return json(await runCortexGroom('manual', user.id, mode));
};

export const PUT: RequestHandler = async ({ locals, request }) => {
	const user = requireUser(locals);
	const body = await request.json().catch(() => ({}));
	// Opting out stops the scheduled pass over your own lattice. Running it by
	// hand from your own Cortex tab is still yours to do.
	setUserGroomEnabled(user.id, body.enabled !== false);
	return json(groomStatus(user.id));
};
