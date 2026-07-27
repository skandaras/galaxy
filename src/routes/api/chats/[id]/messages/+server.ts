import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { getChat } from '$lib/server/chats';
import { EngineError, startChatTurn } from '$lib/server/engine/engine';
import { startResearchTurn } from '$lib/server/engine/research';
import { BudgetExceededError } from '$lib/server/engine/budget';
import { findRunningJobForChat } from '$lib/server/engine/jobs';

export const POST: RequestHandler = async ({ locals, params, request }) => {
	const user = requireUser(locals);
	const chat = getChat(params.id, user.id);
	if (!chat) error(404, 'Chat not found');
	if (findRunningJobForChat(chat.id)) error(409, 'A response is already running for this chat');

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
