import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { getBudgetStatus } from '$lib/server/engine/budget';

/**
 * The spend the cap actually measures, for the whole instance.
 *
 * Deliberately not admin-only: the cap blocks everyone's turns, so everyone
 * needs to see how close it is. Admin → Usage stays admin-only — it exposes
 * per-user and per-model breakdowns, which this does not.
 */
export const GET: RequestHandler = ({ locals }) => {
	requireUser(locals);
	return json(getBudgetStatus());
};
