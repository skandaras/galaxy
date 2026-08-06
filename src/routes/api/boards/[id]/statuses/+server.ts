import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { addStatus, getBoard } from '$lib/server/boards';

export const POST: RequestHandler = async ({ locals, params, request }) => {
	const user = requireUser(locals);
	if (!getBoard(params.id, user.id)) error(404, 'Board not found');
	const body = await request.json().catch(() => ({}));
	const status = addStatus(params.id, user.id, {
		name: typeof body.name === 'string' ? body.name : '',
		colour: typeof body.colour === 'string' ? body.colour : '',
		isDone: body.isDone === true
	});
	if (!status) error(403, 'Not your board');
	return json(status, { status: 201 });
};
