import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireCoder } from '$lib/server/api';
import { getChat, getMessages } from '$lib/server/chats';
import { destroySession, getSession, setSessionMode } from '$lib/server/engine/coding/session';
import { findRunningJobForChat } from '$lib/server/engine/jobs';
import { resolveOpened } from '$lib/server/notifications';

export const GET: RequestHandler = ({ locals, params }) => {
	const user = requireCoder(locals);
	const session = getSession(params.id, user.id);
	if (!session) error(404, 'Session not found');
	// Opening the session clears whatever alert sent you here — same rule as a
	// chat, and a coding session is a chat underneath.
	resolveOpened(user.id, session.chatId);
	const running = findRunningJobForChat(session.chatId);
	return json({
		// modelId lives on the chat row, not the code session, but the client
		// wants it alongside the rest of the session state.
		session: { ...session, modelId: getChat(session.chatId, user.id)?.modelId ?? null },
		messages: getMessages(session.chatId),
		runningJobId: running?.id ?? null,
		// Server time, so a page reopened mid-run shows how long the agent has
		// really been working rather than counting from the reload.
		runningSince: running?.createdAt ?? null
	});
};

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	const user = requireCoder(locals);
	const session = getSession(params.id, user.id);
	if (!session) error(404, 'Session not found');
	const body = await request.json().catch(() => ({}));
	if (body.mode === 'plan' || body.mode === 'implement') {
		setSessionMode(session, body.mode);
	}
	return json(getSession(params.id, user.id));
};

export const DELETE: RequestHandler = ({ locals, params }) => {
	const user = requireCoder(locals);
	const session = getSession(params.id, user.id);
	if (!session) error(404, 'Session not found');
	if (findRunningJobForChat(session.chatId)) error(409, 'A run is in progress');
	destroySession(session);
	return json({ ok: true });
};
