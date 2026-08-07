import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { deleteProject, getBoard, updateProject } from '$lib/server/boards';

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	const user = requireUser(locals);
	if (!getBoard(params.id, user.id)) error(404, 'Board not found');
	const body = await request.json().catch(() => ({}));
	const project = updateProject(params.projectId, user.id, {
		name: typeof body.name === 'string' ? body.name : undefined,
		colour: typeof body.colour === 'string' ? body.colour : undefined
	});
	if (!project) error(404, 'Project not found');
	return json(project);
};

export const DELETE: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	if (!getBoard(params.id, user.id)) error(404, 'Board not found');
	// The cards keep their place on the board; they just lose the label.
	if (!deleteProject(params.projectId, user.id)) error(404, 'Project not found');
	return json({ ok: true });
};
