import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { MAX_LANES, addLane, getBoard } from '$lib/server/boards';

export const POST: RequestHandler = async ({ locals, params, request }) => {
	const user = requireUser(locals);
	if (!getBoard(params.id, user.id)) error(404, 'Board not found');
	const body = await request.json().catch(() => ({}));
	const result = addLane(params.id, user.id, typeof body.name === 'string' ? body.name : '');
	if (!result.ok) {
		if (result.reason === 'limit') error(409, `A board can have at most ${MAX_LANES} lanes`);
		error(403, 'Not your board');
	}
	return json(result.lane, { status: 201 });
};
