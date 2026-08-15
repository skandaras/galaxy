import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { getChat } from '$lib/server/chats';
import { EngineError, startChatTurn } from '$lib/server/engine/engine';
import { startResearchTurn } from '$lib/server/engine/research';
import { BudgetExceededError } from '$lib/server/engine/budget';
import { findRunningJobForChat, jobAgeMinutes } from '$lib/server/engine/jobs';

export const POST: RequestHandler = async ({ locals, params, request }) => {
	const user = requireUser(locals);
	const chat = getChat(params.id, user.id);
	if (!chat) error(404, 'Chat not found');
	// Name the run that is in the way and how old it is. A bare "already
	// running" left no way to tell a reply still streaming from one that stalled
	// half an hour ago, and no way to act on either.
	const running = findRunningJobForChat(chat.id);
	if (running) {
		const mins = jobAgeMinutes(running);
		error(409, {
			message: `A ${running.task === 'deep-research' ? 'deep-research run' : 'reply'} started ${mins < 1 ? 'moments' : `${mins} minute${mins === 1 ? '' : 's'}`} ago is still running for this chat.`,
			jobId: running.id,
			task: running.task,
			ageMinutes: mins
		});
	}

	const body = await request.json().catch(() => ({}));
	const content = typeof body.content === 'string' ? body.content.trim() : '';
	if (!content && !body.attachments?.length) error(400, 'Empty message');

	const attachments = Array.isArray(body.attachments) ? body.attachments : undefined;

	try {
		const job = body.deepResearch
			? startResearchTurn({ chatId: chat.id, userId: user.id, content, attachments })
			: startChatTurn({
					chatId: chat.id,
					userId: user.id,
					content,
					attachments,
					modelId: typeof body.modelId === 'string' ? body.modelId : undefined,
					webSearch: body.webSearch !== false
				});
		return json({ jobId: job.id }, { status: 202 });
	} catch (err) {
		if (err instanceof BudgetExceededError) error(402, err.message);
		if (err instanceof EngineError) error(400, err.message);
		throw err;
	}
};
