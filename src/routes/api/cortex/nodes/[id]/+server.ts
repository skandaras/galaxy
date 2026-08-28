import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import {
	canEdit,
	deleteNode,
	getNode,
	listAssociations,
	mergeNodes,
	saveNode,
	setNodeVisibility
} from '$lib/server/cortex';

export const GET: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	const node = getNode(params.id, user.id);
	if (!node) error(404, 'No such node');
	// Both ends of every edge are already checked against what this user may
	// see, so a connection into someone else's lattice is not in here at all.
	const links = listAssociations(node.id, user.id).map((e) => {
		const otherId = e.sourceId === node.id ? e.targetId : e.sourceId;
		return {
			...e,
			otherId,
			otherName: getNode(otherId, user.id)?.name ?? otherId,
			outbound: e.sourceId === node.id
		};
	});
	return json({ node, links, canEdit: canEdit(node, user.id) });
};

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	const user = requireUser(locals);
	const node = getNode(params.id, user.id);
	if (!node) error(404, 'No such node');
	const body = await request.json().catch(() => ({}));

	try {
		// Merging is a PATCH rather than its own route because it is what an edit
		// turns into once you notice the node you are editing already exists.
		if (typeof body.mergeFrom === 'string') {
			const merged = mergeNodes(node.id, body.mergeFrom, user.id);
			if (!merged) error(404, 'No such node to merge');
			return json(merged);
		}
		// Visibility goes through its own function because it carries the
		// claim-a-legacy-node rule, but it is one field among several and must not
		// end the request.
		//
		// It used to. This branch returned early, and the editor always sends
		// `visibility` because it is bound to a checkbox — so every edit to an
		// existing concept changed only that, silently dropping the name,
		// description, areas and bridge flag. Each field had been tested on its
		// own; none had been sent together, which is the only way to see it.
		if (body.visibility === 'shared' || body.visibility === 'personal') {
			if (!setNodeVisibility(node.id, user.id, body.visibility)) {
				error(403, 'That node is not yours to change');
			}
		}
		return json(
			saveNode({
				id: node.id,
				name: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : node.name,
				description: typeof body.description === 'string' ? body.description : undefined,
				modalities: Array.isArray(body.modalities) ? body.modalities.map(String) : undefined,
				circuits: Array.isArray(body.circuits) ? body.circuits.map(String) : undefined,
				activationPriority:
					typeof body.activationPriority === 'number' ? body.activationPriority : undefined,
				isConvergence: typeof body.isConvergence === 'boolean' ? body.isConvergence : undefined,
				ownerId: user.id
			})
		);
	} catch (err) {
		if (err && typeof err === 'object' && 'status' in err) throw err;
		error(409, err instanceof Error ? err.message : 'Could not update that node');
	}
};

export const DELETE: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	// Someone else's shared node is readable, not deletable.
	if (!deleteNode(params.id, user.id)) error(403, 'That node is not yours to delete');
	return json({ ok: true });
};
