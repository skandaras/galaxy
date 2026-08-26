import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { listNodes, saveNode, seedNodes } from '$lib/server/cortex';

export const GET: RequestHandler = ({ locals, url }) => {
	const user = requireUser(locals);
	const q = url.searchParams.get('q');
	// Scoped to this user: their own nodes plus anything shared.
	return json(q ? seedNodes(q, user.id, 20) : listNodes(user.id));
};

export const POST: RequestHandler = async ({ locals, request }) => {
	const user = requireUser(locals);
	const body = await request.json().catch(() => ({}));
	const name = typeof body.name === 'string' ? body.name.trim() : '';
	if (!name) error(400, 'name is required');
	try {
		return json(
			saveNode({
				name,
				description: typeof body.description === 'string' ? body.description : undefined,
				modalities: Array.isArray(body.modalities) ? body.modalities.map(String) : undefined,
				circuits: Array.isArray(body.circuits) ? body.circuits.map(String) : undefined,
				activationPriority:
					typeof body.activationPriority === 'number' ? body.activationPriority : undefined,
				isConvergence: typeof body.isConvergence === 'boolean' ? body.isConvergence : undefined,
				ownerId: user.id,
				visibility: body.visibility === 'shared' ? 'shared' : 'personal'
			}),
			{ status: 201 }
		);
	} catch (err) {
		// The node cap and the someone-else's-node refusal both land here, and
		// both are things the person can act on rather than server faults.
		error(409, err instanceof Error ? err.message : 'Could not save that node');
	}
};
