import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { listDocs, saveDoc, searchDocs } from '$lib/server/library';

export const GET: RequestHandler = ({ locals, url }) => {
	requireUser(locals);
	const q = url.searchParams.get('q');
	return json(q ? searchDocs(q) : listDocs());
};

export const POST: RequestHandler = async ({ locals, request }) => {
	requireUser(locals);
	const body = await request.json().catch(() => ({}));
	const title = typeof body.title === 'string' ? body.title.trim() : '';
	if (!title) error(400, 'title is required');
	const doc = saveDoc({
		title,
		body: typeof body.content === 'string' ? body.content : '',
		author: 'user'
	});
	return json(doc, { status: 201 });
};
