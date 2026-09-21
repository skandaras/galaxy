import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireCoder } from '$lib/server/api';
import { getEpic } from '$lib/server/forge';
import { runCharter } from '$lib/server/engine/forge-charter';
import { BudgetExceededError } from '$lib/server/engine/budget';
import { EngineError } from '$lib/server/engine/engine';

/**
 * Ask for a different charter.
 *
 * The approval screen used to offer one answer: agree. That is fine when the
 * plan is right and useless when it is not — and the plan is the one thing a
 * person is qualified to correct, because they know what they asked for and the
 * run only knows what it read. So the note goes back to the charter and it
 * plans the whole thing again.
 *
 * Refused once the checks are frozen. After approval the outline is what the
 * driver is working through, and re-planning it would be rewriting the contract
 * underneath a build already following it.
 */
export const POST: RequestHandler = async ({ locals, params, request }) => {
	const user = requireCoder(locals);
	const epic = getEpic(params.id, user.id);
	if (!epic) error(404, 'Epic not found');
	if (epic.approvedAt) {
		error(409, 'This epic is approved — its plan is what the build is following');
	}

	const body = await request.json().catch(() => ({}));
	const note = typeof body.note === 'string' ? body.note.trim() : '';
	if (!note) error(400, 'Say what should be different');

	try {
		const charter = await runCharter(epic, user.id, note);
		return json({ epic: getEpic(epic.id, user.id), charter });
	} catch (err) {
		if (err instanceof BudgetExceededError) error(402, err.message);
		if (err instanceof EngineError) error(400, err.message);
		throw err;
	}
};
