import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { deleteStatus, getBoard, updateStatus } from '$lib/server/boards';

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	const user = requireUser(locals);
	if (!getBoard(params.id, user.id)) error(404, 'Board not found');
	const body = await request.json().catch(() => ({}));
	const status = updateStatus(params.statusId, user.id, {
		name: typeof body.name === 'string' ? body.name : undefined,
		colour: typeof body.colour === 'string' ? body.colour : undefined,
		isDone: typeof body.isDone === 'boolean' ? body.isDone : undefined
	});
	if (!status) error(404, 'Status not found');
	return json(status);
};

export const DELETE: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	if (!getBoard(params.id, user.id)) error(404, 'Board not found');
	// Cards on the removed status fall back to the board's first one.
	if (!deleteStatus(params.statusId, user.id)) {
		error(409, 'That status cannot be removed — a board needs at least one');
	}
	return json({ ok: true });
};
