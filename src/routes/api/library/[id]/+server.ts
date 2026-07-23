import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { deleteDoc, getDoc, saveDoc } from '$lib/server/library';

export const GET: RequestHandler = ({ locals, params }) => {
	requireUser(locals);
	const doc = getDoc(params.id);
	if (!doc) error(404, 'Document not found');
	return json(doc);
};

export const PUT: RequestHandler = async ({ locals, params, request }) => {
	requireUser(locals);
	const existing = getDoc(params.id);
	if (!existing) error(404, 'Document not found');
	const body = await request.json().catch(() => ({}));
	const doc = saveDoc({
		id: params.id,
		title: typeof body.title === 'string' && body.title.trim() ? body.title.trim() : existing.meta.title,
		body: typeof body.content === 'string' ? body.content : existing.body,
		author: existing.meta.author
	});
	return json(doc);
};

export const DELETE: RequestHandler = ({ locals, params }) => {
	requireUser(locals);
	if (!deleteDoc(params.id)) error(404, 'Document not found');
	return json({ ok: true });
};
