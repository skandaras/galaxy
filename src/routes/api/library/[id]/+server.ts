import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { canEdit, deleteDoc, getDoc, saveDoc, setVisibility } from '$lib/server/library';

export const GET: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	// A doc you cannot see is indistinguishable from one that isn't there.
	const doc = getDoc(params.id, user.id);
	if (!doc) error(404, 'Document not found');
	return json({ ...doc, canEdit: canEdit(doc.meta, user.id) });
};

export const PUT: RequestHandler = async ({ locals, params, request }) => {
	const user = requireUser(locals);
	const existing = getDoc(params.id, user.id);
	if (!existing) error(404, 'Document not found');
	// Someone else's shared doc is readable, not writable.
	if (!canEdit(existing.meta, user.id)) error(403, 'This document belongs to another user');

	const body = await request.json().catch(() => ({}));
	if (body.visibility === 'shared' || body.visibility === 'personal') {
		if (!setVisibility(params.id, user.id, body.visibility)) {
			error(403, 'This document belongs to another user');
		}
	}
	const doc = saveDoc({
		id: params.id,
		title:
			typeof body.title === 'string' && body.title.trim() ? body.title.trim() : existing.meta.title,
		body: typeof body.content === 'string' ? body.content : existing.body,
		author: existing.meta.author,
		ownerId: user.id
	});
	return json(doc);
};

export const DELETE: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	const existing = getDoc(params.id, user.id);
	if (!existing) error(404, 'Document not found');
	if (!deleteDoc(params.id, user.id)) error(403, 'This document belongs to another user');
	return json({ ok: true });
};
