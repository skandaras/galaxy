import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { fileDoc, type FilingDest } from '$lib/server/library';

/**
 * Re-file a document: under another document, or into a folder.
 *
 * Its own route rather than a field on PUT because a drag has no business
 * sending the body back — PUT writes the file on disk and carries the
 * `baseUpdatedAt` conflict check with it, neither of which a move needs.
 */
export const POST: RequestHandler = async ({ locals, params, request }) => {
	const user = requireUser(locals);
	const body = await request.json().catch(() => ({}));
	const dest: FilingDest | null =
		typeof body.parentId === 'string' && body.parentId
			? { parentId: body.parentId }
			: typeof body.folder === 'string'
				? { folder: body.folder }
				: null;
	if (!dest) error(400, 'Say which folder or which document to file it under');

	const result = fileDoc(params.id, user.id, dest);
	if (!result.ok) {
		if (result.reason === 'forbidden') error(404, 'Document not found');
		if (result.reason === 'no-parent') error(404, 'No such document to file it under');
		error(400, `Cannot file a document there: ${result.reason}`);
	}
	return json(result.doc);
};
