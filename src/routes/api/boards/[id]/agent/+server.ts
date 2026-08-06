import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { getBoard } from '$lib/server/boards';
import { BOARD_ACTIONS, startBoardTurn, type BoardAction } from '$lib/server/engine/board-agent';
import { EngineError } from '$lib/server/engine/engine';
import { BudgetExceededError } from '$lib/server/engine/budget';

/** Run an agent across every open card on a board. */
export const POST: RequestHandler = async ({ locals, params, request }) => {
	const user = requireUser(locals);
	const board = getBoard(params.id, user.id);
	if (!board) error(404, 'Board not found');

	const body = await request.json().catch(() => ({}));
	const action = body.action as BoardAction;
	if (!(action in BOARD_ACTIONS)) {
		error(400, `Unknown action. Try one of: ${Object.keys(BOARD_ACTIONS).join(', ')}`);
	}

	try {
		const { chatId, job } = startBoardTurn(board, action, user.id);
		return json({ chatId, jobId: job.id }, { status: 202 });
	} catch (err) {
		if (err instanceof BudgetExceededError) error(402, err.message);
		if (err instanceof EngineError) error(400, err.message);
		throw err;
	}
};
