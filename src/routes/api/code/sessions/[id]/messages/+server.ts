import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { BudgetExceededError } from '$lib/server/engine/budget';
import { getSession, startCodingTurn } from '$lib/server/engine/coding/session';
import { EngineError } from '$lib/server/engine/engine';
import { findRunningJobForChat } from '$lib/server/engine/jobs';

export const POST: RequestHandler = async ({ locals, params, request }) => {
	const user = requireUser(locals);
	const session = getSession(params.id, user.id);
	if (!session) error(404, 'Session not found');
	if (findRunningJobForChat(session.chatId)) error(409, 'A run is already in progress');

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
			modelId: typeof body.modelId === 'string' ? body.modelId : undefined
		});
		return json({ jobId: job.id }, { status: 202 });
	} catch (err) {
		if (err instanceof BudgetExceededError) error(402, err.message);
		if (err instanceof EngineError) error(400, err.message);
		throw err;
	}
};
