import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import {
	canEdit,
	deleteDoc,
	docPath,
	getDoc,
	LibraryTreeError,
	saveDoc,
	setVisibility
} from '$lib/server/library';

export const GET: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	// A doc you cannot see is indistinguishable from one that isn't there.
	const doc = getDoc(params.id, user.id);
	if (!doc) error(404, 'Document not found');
	return json({ ...doc, canEdit: canEdit(doc.meta, user.id), path: docPath(doc.meta.id, user.id) });
};

export const PUT: RequestHandler = async ({ locals, params, request }) => {
	const user = requireUser(locals);
	const existing = getDoc(params.id, user.id);
	if (!existing) error(404, 'Document not found');
	// Someone else's shared doc is readable, not writable.
	if (!canEdit(existing.meta, user.id)) error(403, 'This document belongs to another user');

	const body = await request.json().catch(() => ({}));
	/**
	 * Optimistic concurrency, checked before anything writes.
	 *
	 * `saveDoc` replaces the whole body, and two writers is no longer a remote
	 * case: the editor autosaves about once a second, and `library_write` lets an
	 * agent target the same document. A caller that sends the `updatedAt` it read
	 * is told when the stored row has moved on since, rather than silently
	 * flattening whatever landed in between.
	 *
	 * Ahead of setVisibility deliberately — that writes its own updatedAt, so
	 * checking after it would be comparing against a row this request had already
	 * changed.
	 */
	if (typeof body.baseUpdatedAt === 'string' || typeof body.baseUpdatedAt === 'number') {
		const base = new Date(body.baseUpdatedAt).getTime();
		if (Number.isFinite(base) && existing.meta.updatedAt.getTime() > base) {
			error(409, 'This document changed somewhere else since you opened it');
		}
	}
	if (body.visibility === 'shared' || body.visibility === 'personal') {
		if (!setVisibility(params.id, user.id, body.visibility)) {
			error(403, 'This document belongs to another user');
		}
	}
	try {
		const doc = saveDoc({
			id: params.id,
			title:
				typeof body.title === 'string' && body.title.trim()
					? body.title.trim()
					: existing.meta.title,
			body: typeof body.content === 'string' ? body.content : existing.body,
			author: existing.meta.author,
			ownerId: user.id,
			// Undefined leaves it filed where it was; '' is a deliberate unfiling.
			folder: typeof body.folder === 'string' ? body.folder : undefined,
			parentId: typeof body.parentId === 'string' ? body.parentId || null : undefined
		});
		return json(doc);
	} catch (err) {
		if (err instanceof LibraryTreeError) error(400, err.message);
		throw err;
	}
};

export const DELETE: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	const existing = getDoc(params.id, user.id);
	if (!existing) error(404, 'Document not found');
	if (!deleteDoc(params.id, user.id)) error(403, 'This document belongs to another user');
	return json({ ok: true });
};
