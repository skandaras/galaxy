import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { getCard } from '$lib/server/boards';
import { startCardTurn } from '$lib/server/engine/board-agent';
import { EngineError } from '$lib/server/engine/engine';
import { BudgetExceededError } from '$lib/server/engine/budget';

/**
 * Hand a card to an agent. Returns the chat the work happens in — the client
 * navigates there, where streaming, recovery and the ask-user drawer already
 * live.
 */
export const POST: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	if (!getCard(params.id, user.id)) error(404, 'Card not found');

	try {
		const { chatId, job } = startCardTurn(params.id, user.id);
		return json({ chatId, jobId: job.id }, { status: 202 });
	} catch (err) {
		if (err instanceof BudgetExceededError) error(402, err.message);
		if (err instanceof EngineError) error(400, err.message);
		throw err;
	}
};
