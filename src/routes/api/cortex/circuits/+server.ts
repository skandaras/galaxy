import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { circuitIndex, listCircuits, normaliseColour, saveCircuit } from '$lib/server/cortex';

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
	// Undefined stays undefined so `saveCircuit` keeps what is stored: this one
	// endpoint both creates an area and renames one, and a rename sends no colour.
	const colour = 'colour' in body ? normaliseColour(body.colour) : undefined;
	if (colour === null) error(400, 'colour must be a hex like #7f9cff, or empty');
	try {
		return json(
			saveCircuit({
				id: typeof body.id === 'string' ? body.id : undefined,
				name,
				description: typeof body.description === 'string' ? body.description : undefined,
				colour,
				ownerId: user.id
			}),
			{ status: 201 }
		);
	} catch (err) {
		error(409, err instanceof Error ? err.message : 'Could not save that area');
	}
};
