import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { importLattice } from '$lib/server/cortex';

export const POST: RequestHandler = async ({ locals, request }) => {
	const user = requireUser(locals);
	const body = await request.json().catch(() => null);
	if (!body || typeof body !== 'object') error(400, 'Expected a lattice export');
	// The owner is the caller, never the file — see importLattice. Nothing here
	// needs to check that, which is the point of it being enforced there.
	return json(importLattice(user.id, body));
};
