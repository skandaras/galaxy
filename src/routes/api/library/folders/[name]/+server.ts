import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { deleteFolder, renameFolder } from '$lib/server/library';

export const PUT: RequestHandler = async ({ locals, params, request }) => {
	const user = requireUser(locals);
	const body = await request.json().catch(() => ({}));
	const result = renameFolder(user.id, params.name, typeof body.name === 'string' ? body.name : '');
	if (!result.ok) {
		// "Exists but not yours" answers 404, the same as everywhere else here.
		if (result.reason === 'forbidden') error(404, 'Folder not found');
		if (result.reason === 'exists') error(409, 'There is already a folder with that name');
		if (result.reason === 'reserved') error(400, 'Unfiled is where documents go with no folder');
		error(400, 'A folder needs a name');
	}
	return json(result.folder);
};

export const DELETE: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	// Its documents fall back to Unfiled; deleteFolder is where that is written.
	if (!deleteFolder(user.id, params.name)) error(404, 'Folder not found');
	return json({ ok: true });
};
