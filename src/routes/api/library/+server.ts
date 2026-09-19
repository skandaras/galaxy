import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { LibraryTreeError, listDocs, saveDoc, searchDocs } from '$lib/server/library';

export const GET: RequestHandler = ({ locals, url }) => {
	const user = requireUser(locals);
	const q = url.searchParams.get('q');
	// Scoped to this user: their own docs plus anything shared.
	return json(q ? searchDocs(q, user.id) : listDocs(user.id));
};

export const POST: RequestHandler = async ({ locals, request }) => {
	const user = requireUser(locals);
	const body = await request.json().catch(() => ({}));
	const title = typeof body.title === 'string' ? body.title.trim() : '';
	if (!title) error(400, 'title is required');
	try {
		const doc = saveDoc({
			title,
			body: typeof body.content === 'string' ? body.content : '',
			author: 'user',
			ownerId: user.id,
			// New docs are personal unless the caller asks otherwise; the library used
			// to be entirely global, so sharing is now deliberate.
			visibility: body.visibility === 'shared' ? 'shared' : 'personal',
			folder: typeof body.folder === 'string' ? body.folder : undefined,
			// null files it at the top; undefined leaves it wherever it is.
			parentId: typeof body.parentId === 'string' ? body.parentId || null : undefined
		});
		return json(doc, { status: 201 });
	} catch (err) {
		// A parent that would make a cycle or breach the depth cap is a bad
		// request, not a server fault — saveDoc throws because it answers with a
		// row rather than a result object.
		if (err instanceof LibraryTreeError) error(400, err.message);
		throw err;
	}
};
