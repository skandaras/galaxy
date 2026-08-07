import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { boardQuota, createBoard, listBoards } from '$lib/server/boards';

export const GET: RequestHandler = ({ locals, url }) => {
	const user = requireUser(locals);
	// Membership is the only way onto a board, so this is already scoped.
	return json(listBoards(user.id, url.searchParams.get('archived') === '1'));
};

export const POST: RequestHandler = async ({ locals, request }) => {
	const user = requireUser(locals);
	const body = await request.json().catch(() => ({}));
	const name = typeof body.name === 'string' ? body.name.trim() : '';
	if (!name) error(400, 'name is required');

	const quota = boardQuota(user.id);
	if (quota.exceeded) {
		error(409, `You already own ${quota.owned} boards, which is the limit an admin has set`);
	}

	const board = createBoard({
		ownerId: user.id,
		name,
		description: typeof body.description === 'string' ? body.description : ''
	});
	return json(board, { status: 201 });
};
