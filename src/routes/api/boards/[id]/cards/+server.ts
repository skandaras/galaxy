import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { createCard, getBoard } from '$lib/server/boards';
import { CARD_PRIORITIES, type CardPriority } from '$lib/server/db/schema';

const priority = (v: unknown): CardPriority | undefined =>
	CARD_PRIORITIES.includes(v as CardPriority) ? (v as CardPriority) : undefined;

export const POST: RequestHandler = async ({ locals, params, request }) => {
	const user = requireUser(locals);
	if (!getBoard(params.id, user.id)) error(404, 'Board not found');
	const body = await request.json().catch(() => ({}));
	const title = typeof body.title === 'string' ? body.title.trim() : '';
	if (!title) error(400, 'title is required');

	const card = createCard(params.id, user.id, {
		title,
		description: typeof body.description === 'string' ? body.description : '',
		laneId: typeof body.laneId === 'string' ? body.laneId : undefined,
		statusId: typeof body.statusId === 'string' ? body.statusId : undefined,
		priority: priority(body.priority),
		assignedTo: typeof body.assignedTo === 'string' ? body.assignedTo : null
	});
	if (!card) error(409, 'This board has no lanes or statuses to put a card in');
	return json(card, { status: 201 });
};
