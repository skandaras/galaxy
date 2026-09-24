import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireCoder } from '$lib/server/api';
import { BudgetExceededError } from '$lib/server/engine/budget';
import { EngineError } from '$lib/server/engine/engine';
import { GithubError } from '$lib/server/ivory/github';
import { IvoryRunError, startPlanRun } from '$lib/server/ivory/run';
import { shelfErrorMessage } from '$lib/server/ivory/view';
import { ivorySettings } from '$lib/server/settings';

// Run the planner on a project. It ends in a proposal; nothing reaches the board until it is approved.
export const POST: RequestHandler = async ({ locals, params }) => {
	const user = requireCoder(locals);
	try {
		const { chatId, job } = await startPlanRun({ slug: params.slug, userId: user.id });
		return json({ chatId, jobId: job.id }, { status: 202 });
	} catch (err) {
		if (err instanceof IvoryRunError) error(err.status, err.message);
		if (err instanceof BudgetExceededError) error(402, err.message);
		if (err instanceof EngineError) error(400, err.message);
		if (err instanceof GithubError) error(502, shelfErrorMessage(err, ivorySettings().shelfRepo));
		throw err;
	}
};
