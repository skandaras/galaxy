import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireCoder } from '$lib/server/api';
import { emitEvent } from '$lib/server/engine/events';
import { shelfClient } from '$lib/server/ivory/github';
import { PlanError, rejectPlan } from '$lib/server/ivory/plan';
import { writeProjectStatus } from '$lib/server/ivory/status';

// Reject a plan. No task reaches GitHub; the project's status line says so.
export const POST: RequestHandler = async ({ locals, params }) => {
	const user = requireCoder(locals);
	let slug: string;
	try {
		slug = rejectPlan({ chatId: params.chatId, userId: user.id }).slug;
	} catch (err) {
		if (err instanceof PlanError) error(err.status, err.message);
		throw err;
	}
	// The planner's own line said a plan was waiting, which is no longer true.
	const client = shelfClient();
	if (client) {
		await writeProjectStatus(client, slug, { text: 'Plan rejected; nothing filed.', by: 'Galaxy' }).catch((err) =>
			emitEvent({
				userId: user.id,
				chatId: params.chatId,
				task: 'ivory-plan',
				type: 'tool.call',
				name: 'ivory.status',
				status: 'error',
				detail: { error: String(err) }
			})
		);
	}
	return json({ ok: true });
};
