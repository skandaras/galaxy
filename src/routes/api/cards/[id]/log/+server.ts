import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { getCard, logCard } from '$lib/server/boards';

/**
 * A comment is just another Log line, so an agent picking the card up reads
 * notes and history in one stream rather than two.
 */
export const POST: RequestHandler = async ({ locals, params, request }) => {
	const user = requireUser(locals);
	if (!getCard(params.id, user.id)) error(404, 'Card not found');
	const body = await request.json().catch(() => ({}));
	const detail = typeof body.detail === 'string' ? body.detail.trim() : '';
	if (!detail) error(400, 'detail is required');
	return json(
		logCard(params.id, { actor: 'user', userId: user.id, event: 'comment', detail }),
		{ status: 201 }
	);
};
