import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { deleteCard, getCard, updateCard } from '$lib/server/boards';
import { CARD_PRIORITIES, type CardPriority } from '$lib/server/db/schema';

const priority = (v: unknown): CardPriority | undefined =>
	CARD_PRIORITIES.includes(v as CardPriority) ? (v as CardPriority) : undefined;

export const GET: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	const detail = getCard(params.id, user.id);
	if (!detail) error(404, 'Card not found');
	return json(detail);
};

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	const user = requireUser(locals);
	if (!getCard(params.id, user.id)) error(404, 'Card not found');
	const body = await request.json().catch(() => ({}));

	const card = updateCard(params.id, user.id, {
		title: typeof body.title === 'string' ? body.title : undefined,
		description: typeof body.description === 'string' ? body.description : undefined,
		laneId: typeof body.laneId === 'string' ? body.laneId : undefined,
		statusId: typeof body.statusId === 'string' ? body.statusId : undefined,
		priority: priority(body.priority),
		// null clears the project, so undefined is the only "leave it alone".
		projectId:
			body.projectId === null || typeof body.projectId === 'string' ? body.projectId : undefined,
		// null is meaningful here — it unassigns — so undefined is the only "leave it".
		assignedTo:
			body.assignedTo === null || typeof body.assignedTo === 'string' ? body.assignedTo : undefined,
		position: typeof body.position === 'number' ? body.position : undefined,
		archived: typeof body.archived === 'boolean' ? body.archived : undefined
	});
	if (!card) error(404, 'Card not found');
	return json(card);
};

export const DELETE: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	if (!getCard(params.id, user.id)) error(404, 'Card not found');
	if (!deleteCard(params.id, user.id)) error(404, 'Card not found');
	return json({ ok: true });
};
