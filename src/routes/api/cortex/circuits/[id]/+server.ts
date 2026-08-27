import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { deleteCircuit } from '$lib/server/cortex';

export const DELETE: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	// Nodes filed under it survive and become unfiled: deleting a label must
	// never delete what was labelled.
	if (!deleteCircuit(params.id, user.id)) error(403, 'That area is not yours to delete');
	return json({ ok: true });
};
