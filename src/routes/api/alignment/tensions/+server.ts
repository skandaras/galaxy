import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAlignment } from '$lib/server/api';
import { AlignmentError, listTensions, saveTension } from '$lib/server/alignment';

export const GET: RequestHandler = ({ locals }) => {
	const user = requireAlignment(locals);
	return json({ tensions: listTensions(user.id) });
};

export const POST: RequestHandler = async ({ locals, request }) => {
	const user = requireAlignment(locals);
	const body = await request.json().catch(() => ({}));
	if (typeof body.aId !== 'string' || typeof body.bId !== 'string') {
		error(400, 'aId and bId are required');
	}
	try {
		return json({ tension: saveTension(user.id, body.aId, body.bId, String(body.note ?? '')) });
	} catch (err) {
		if (err instanceof AlignmentError) error(400, err.message);
		throw err;
	}
};
