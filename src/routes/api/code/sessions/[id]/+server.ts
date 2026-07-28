import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { getChat, getMessages } from '$lib/server/chats';
import { destroySession, getSession, setSessionMode } from '$lib/server/engine/coding/session';
import { findRunningJobForChat } from '$lib/server/engine/jobs';

export const GET: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	const session = getSession(params.id, user.id);
	if (!session) error(404, 'Session not found');
	return json({
		// modelId lives on the chat row, not the code session, but the client
		// wants it alongside the rest of the session state.
		session: { ...session, modelId: getChat(session.chatId, user.id)?.modelId ?? null },
		messages: getMessages(session.chatId),
		runningJobId: findRunningJobForChat(session.chatId)?.id ?? null
	});
};

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	const user = requireUser(locals);
	const session = getSession(params.id, user.id);
	if (!session) error(404, 'Session not found');
	const body = await request.json().catch(() => ({}));
	if (body.mode === 'plan' || body.mode === 'implement') {
		setSessionMode(session, body.mode);
	}
	return json(getSession(params.id, user.id));
};

export const DELETE: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	const session = getSession(params.id, user.id);
	if (!session) error(404, 'Session not found');
	if (findRunningJobForChat(session.chatId)) error(409, 'A run is in progress');
	destroySession(session);
	return json({ ok: true });
};
