import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireCoder } from '$lib/server/api';
import { BudgetExceededError } from '$lib/server/engine/budget';
import { EngineError } from '$lib/server/engine/engine';
import { IvoryRunError, startTaskRun } from '$lib/server/ivory/run';
import { shelfErrorMessage } from '$lib/server/ivory/view';
import { GithubError } from '$lib/server/ivory/github';
import { ivorySettings } from '$lib/server/settings';

// Run the agent an issue is labelled for. The issue stays open; the owner closes it.
export const POST: RequestHandler = async ({ locals, params }) => {
	const user = requireCoder(locals);
	const number = Number(params.number);
	if (!Number.isInteger(number) || number < 1) error(400, 'Not an issue number');
	try {
		const { chatId, job } = await startTaskRun({ slug: params.slug, issueNumber: number, userId: user.id });
		return json({ chatId, jobId: job.id }, { status: 202 });
	} catch (err) {
		if (err instanceof IvoryRunError) error(err.status, err.message);
		if (err instanceof BudgetExceededError) error(402, err.message);
		if (err instanceof EngineError) error(400, err.message);
		if (err instanceof GithubError) error(502, shelfErrorMessage(err, ivorySettings().shelfRepo));
		throw err;
	}
};
