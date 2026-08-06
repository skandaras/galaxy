import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import {
	boardRole,
	deleteBoard,
	getBoard,
	listArchivedCards,
	listCards,
	listLanes,
	listMembers,
	listStatuses,
	updateBoard
} from '$lib/server/boards';

/** Everything the board view needs, in one round trip. */
export const GET: RequestHandler = ({ locals, params, url }) => {
	const user = requireUser(locals);
	const board = getBoard(params.id, user.id);
	// A board you are not a member of is indistinguishable from one that isn't there.
	if (!board) error(404, 'Board not found');
	return json({
		board,
		role: boardRole(params.id, user.id),
		lanes: listLanes(params.id),
		statuses: listStatuses(params.id),
		cards: listCards(params.id),
		members: listMembers(params.id, user.id) ?? [],
		archived: url.searchParams.get('archived') === '1' ? listArchivedCards(params.id) : []
	});
};

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	const user = requireUser(locals);
	if (!getBoard(params.id, user.id)) error(404, 'Board not found');
	const body = await request.json().catch(() => ({}));
	const board = updateBoard(params.id, user.id, {
		name: typeof body.name === 'string' ? body.name : undefined,
		description: typeof body.description === 'string' ? body.description : undefined,
		archived: typeof body.archived === 'boolean' ? body.archived : undefined
	});
	if (!board) error(403, 'Only the board owner can change the board itself');
	return json(board);
};

export const DELETE: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	if (!getBoard(params.id, user.id)) error(404, 'Board not found');
	if (!deleteBoard(params.id, user.id)) error(403, 'Only the board owner can delete it');
	return json({ ok: true });
};
