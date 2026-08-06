import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { deleteLane, getBoard, renameLane } from '$lib/server/boards';

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	const user = requireUser(locals);
	if (!getBoard(params.id, user.id)) error(404, 'Board not found');
	const body = await request.json().catch(() => ({}));
	const lane = renameLane(params.laneId, user.id, typeof body.name === 'string' ? body.name : '');
	if (!lane) error(404, 'Lane not found');
	return json(lane);
};

export const DELETE: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	if (!getBoard(params.id, user.id)) error(404, 'Board not found');
	// Cards in the lane move to a neighbour rather than disappearing with it.
	if (!deleteLane(params.laneId, user.id)) {
		error(409, 'That lane cannot be removed — a board needs at least one');
	}
	return json({ ok: true });
};
