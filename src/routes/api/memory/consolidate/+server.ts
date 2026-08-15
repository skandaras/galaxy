import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { applyConsolidation, consolidateMemory } from '$lib/server/engine/memory';

/**
 * Propose a consolidation. Writes nothing — the caller sees the plan first.
 *
 * Own memories only, like every other route here: a run reads that user's
 * private observations, so it stays theirs to trigger.
 */
export const POST: RequestHandler = async ({ locals }) => {
	const user = requireUser(locals);
	return json(await consolidateMemory(user.id));
};

/** Apply a plan the user approved. Ids are re-checked against their own rows. */
export const PUT: RequestHandler = async ({ locals, request }) => {
	const user = requireUser(locals);
	const body = await request.json().catch(() => ({}));
	return json(
		applyConsolidation(user.id, {
			merged: Array.isArray(body.merged) ? body.merged : [],
			drop: Array.isArray(body.drop) ? body.drop : []
		})
	);
};
