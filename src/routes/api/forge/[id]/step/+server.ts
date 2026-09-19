import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireCoder } from '$lib/server/api';
import { getEpic } from '$lib/server/forge';
import { runStep } from '$lib/server/engine/forge-run';
import { BudgetExceededError } from '$lib/server/engine/budget';
import { EngineError } from '$lib/server/engine/engine';

/**
 * Advance the epic by exactly one step.
 *
 * One, not a loop: a button that runs a build to completion is the scheduler
 * sweep wearing a disguise, and the point of driving it by hand is to look at
 * what each step did before asking for the next.
 *
 * Two answers, because the steps genuinely differ. Planning, gating and closing
 * all finish inline and come back 200 with what happened. Starting a task hands
 * off to a coding turn that may run for twenty minutes, so that one comes back
 * 202 with the job to stream — the same shape the card and board agents use.
 */
export const POST: RequestHandler = async ({ locals, params }) => {
	const user = requireCoder(locals);
	const epic = getEpic(params.id, user.id);
	if (!epic) error(404, 'Epic not found');

	try {
		const outcome = await runStep(epic, user.id);
		return json(outcome, { status: outcome.started ? 202 : 200 });
	} catch (err) {
		if (err instanceof BudgetExceededError) error(402, err.message);
		if (err instanceof EngineError) error(400, err.message);
		throw err;
	}
};
