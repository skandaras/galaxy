import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { circuitIndex, listCircuits, saveCircuit } from '$lib/server/cortex';

export const GET: RequestHandler = ({ locals }) => {
	const user = requireUser(locals);
	// Counts come with the list because every caller wants both: the panel to
	// show how full an area is, and the map to decide which are worth labelling.
	const counts = new Map(circuitIndex(user.id).circuits.map((c) => [c.id, c.count]));
	return json(listCircuits(user.id).map((c) => ({ ...c, count: counts.get(c.id) ?? 0 })));
};

export const POST: RequestHandler = async ({ locals, request }) => {
	const user = requireUser(locals);
	const body = await request.json().catch(() => ({}));
	const name = typeof body.name === 'string' ? body.name.trim() : '';
	if (!name) error(400, 'name is required');
	try {
		return json(
			saveCircuit({
				id: typeof body.id === 'string' ? body.id : undefined,
				name,
				description: typeof body.description === 'string' ? body.description : undefined,
				ownerId: user.id
			}),
			{ status: 201 }
		);
	} catch (err) {
		error(409, err instanceof Error ? err.message : 'Could not save that area');
	}
};
