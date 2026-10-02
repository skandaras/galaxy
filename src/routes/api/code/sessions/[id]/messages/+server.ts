import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireCoder } from '$lib/server/api';
import { BudgetExceededError } from '$lib/server/engine/budget';
import { getSession, startCodingTurn } from '$lib/server/engine/coding/session';
import { EngineError } from '$lib/server/engine/engine';
import { findRunningJobForChat, jobAgeMinutes } from '$lib/server/engine/jobs';

export const POST: RequestHandler = async ({ locals, params, request }) => {
	const user = requireCoder(locals);
	const session = getSession(params.id, user.id);
	if (!session) error(404, 'Session not found');
	// Named, with its id, as the chat route does: a bare "already in progress"
	// left the page no way to offer to stop it.
	const running = findRunningJobForChat(session.chatId);
	if (running) {
		const mins = jobAgeMinutes(running);
		error(409, {
			message: `A run started ${mins < 1 ? 'moments' : `${mins} minute${mins === 1 ? '' : 's'}`} ago is still going in this session.`,
			jobId: running.id,
			task: running.task,
			ageMinutes: mins
		});
	}

	const body = await request.json().catch(() => ({}));
	const content = typeof body.content === 'string' ? body.content.trim() : '';
	const attachments = Array.isArray(body.attachments) ? body.attachments : undefined;
	if (!content && !attachments?.length) error(400, 'Empty message');

	try {
		const job = startCodingTurn({
			session,
			userId: user.id,
			content,
			attachments,
			modelId: typeof body.modelId === 'string' ? body.modelId : undefined,
			// Default on, matching chat: absent means the client didn't say.
			webSearch: body.webSearch !== false
		});
		return json({ jobId: job.id }, { status: 202 });
	} catch (err) {
		if (err instanceof BudgetExceededError) error(402, err.message);
		if (err instanceof EngineError) error(400, err.message);
		throw err;
	}
};
