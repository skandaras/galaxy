import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { createFolder, listFolders } from '$lib/server/library';

export const GET: RequestHandler = ({ locals }) => {
	const user = requireUser(locals);
	// Names, not rows: the shelf groups on the label a doc carries, and a folder
	// somebody else shared a doc into is a folder here without a row of its own.
	return json(listFolders(user.id));
};

export const POST: RequestHandler = async ({ locals, request }) => {
	const user = requireUser(locals);
	const body = await request.json().catch(() => ({}));
	const result = createFolder(user.id, typeof body.name === 'string' ? body.name : '');
	if (!result.ok) {
		if (result.reason === 'exists') error(409, 'There is already a folder with that name');
		if (result.reason === 'reserved') error(400, 'Unfiled is where documents go with no folder');
		error(400, 'A folder needs a name');
	}
	return json(result.folder, { status: 201 });
};
