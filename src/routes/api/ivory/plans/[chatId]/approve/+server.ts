import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireCoder } from '$lib/server/api';
import { emitEvent } from '$lib/server/engine/events';
import { GithubError, shelfClient } from '$lib/server/ivory/github';
import { approvePlan, PlanError } from '$lib/server/ivory/plan';
import { shelfErrorMessage } from '$lib/server/ivory/view';

// Approve a plan, as edited by the owner. This handler, never the planner, creates the issues.
export const POST: RequestHandler = async ({ locals, params, request }) => {
	const user = requireCoder(locals);
	const client = shelfClient();
	if (!client) error(409, 'No GitHub token is configured. Add one in Admin → Settings → GitHub.');
	const body = await request.json().catch(() => ({}));
	try {
		const result = await approvePlan(client, { chatId: params.chatId, userId: user.id, tasks: body.tasks });
		emitEvent({
			userId: user.id,
			chatId: params.chatId,
			task: 'ivory-plan',
			type: 'tool.call',
			name: 'ivory.approve',
			status: result.failed ? 'error' : 'ok',
			detail: { created: result.created.map((c) => c.number), failed: result.failed ?? null }
		});
		return json(result);
	} catch (err) {
		if (err instanceof PlanError) error(err.status, err.message);
		if (err instanceof GithubError) error(502, shelfErrorMessage(err, client.repo));
		throw err;
	}
};
