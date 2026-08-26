import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { deleteAssociation, saveAssociation } from '$lib/server/cortex';

export const POST: RequestHandler = async ({ locals, request }) => {
	const user = requireUser(locals);
	const body = await request.json().catch(() => ({}));
	const source = typeof body.source === 'string' ? body.source : '';
	const target = typeof body.target === 'string' ? body.target : '';
	if (!source || !target) error(400, 'source and target are required');
	try {
		return json(
			saveAssociation({
				sourceId: source,
				targetId: target,
				weight: typeof body.weight === 'number' ? body.weight : undefined,
				description: typeof body.description === 'string' ? body.description : undefined,
				contextTags: Array.isArray(body.contextTags) ? body.contextTags.map(String) : undefined,
				directionality: body.directionality === 'asymmetric' ? 'asymmetric' : 'symmetric',
				userId: user.id
			}),
			{ status: 201 }
		);
	} catch (err) {
		// Includes the refusal to build an edge into a lattice you can only read.
		error(409, err instanceof Error ? err.message : 'Could not connect those');
	}
};

export const DELETE: RequestHandler = async ({ locals, request }) => {
	const user = requireUser(locals);
	const body = await request.json().catch(() => ({}));
	const source = typeof body.source === 'string' ? body.source : '';
	const target = typeof body.target === 'string' ? body.target : '';
	if (!source || !target) error(400, 'source and target are required');
	if (!deleteAssociation(source, target, user.id)) error(404, 'No such connection');
	return json({ ok: true });
};
