import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { addProject, getBoard } from '$lib/server/boards';

export const POST: RequestHandler = async ({ locals, params, request }) => {
	const user = requireUser(locals);
	if (!getBoard(params.id, user.id)) error(404, 'Board not found');
	const body = await request.json().catch(() => ({}));
	const name = typeof body.name === 'string' ? body.name.trim() : '';
	if (!name) error(400, 'name is required');

	const project = addProject(params.id, user.id, {
		name,
		colour: typeof body.colour === 'string' ? body.colour : undefined
	});
	if (!project) error(403, 'Not your board');
	return json(project, { status: 201 });
};
