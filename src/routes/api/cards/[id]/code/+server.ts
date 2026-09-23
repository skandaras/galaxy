import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireCoder } from '$lib/server/api';
import { getCard } from '$lib/server/boards';
import { startCardCoding } from '$lib/server/engine/board-agent';
import { EngineError } from '$lib/server/engine/engine';
import { BudgetExceededError } from '$lib/server/engine/budget';

/**
 * Start a card as a coding session on the repository it was filed against.
 * Returns the session's chat id; the client opens it on the Code page.
 */
export const POST: RequestHandler = async ({ locals, params }) => {
	const user = requireCoder(locals);
	const detail = getCard(params.id, user.id);
	if (!detail) error(404, 'Card not found');
	if (!detail.card.repoUrl) error(400, 'This card is not tied to a repository');

	try {
		const { chatId, job } = await startCardCoding(params.id, user.id);
		return json({ chatId, jobId: job.id }, { status: 202 });
	} catch (err) {
		if (err instanceof BudgetExceededError) error(402, err.message);
		if (err instanceof EngineError) error(400, err.message);
		error(502, String(err instanceof Error ? err.message : err));
	}
};
