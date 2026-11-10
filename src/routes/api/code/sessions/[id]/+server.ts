import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireCoder } from '$lib/server/api';
import { getChat, getMessages } from '$lib/server/chats';
import { CODE_MODES } from '$lib/server/db/schema';
import {
	destroySession,
	getSession,
	setOrchestrateModels,
	setSessionMode,
	usableWorkerModel
} from '$lib/server/engine/coding/session';
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
	const chat = getChat(session.chatId, user.id);
	return json({
		// modelId and the title live on the chat row, not the code session, but
		// the client wants them alongside the rest of the session state.
		session: {
			...session,
			modelId: chat?.modelId ?? null,
			title: chat?.title ?? session.repoName
		},
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
	// Validated before anything is written, so a bad tier id does not leave the
	// mode changed behind a 400.
	const tiers: { tier1?: string | null; tier2?: string | null } = {};
	if (body.tierModels !== undefined) {
		const t = body.tierModels;
		if (!t || typeof t !== 'object' || Array.isArray(t)) error(400, 'tierModels must be an object');
		for (const tier of ['tier1', 'tier2'] as const) {
			if (!(tier in t)) continue;
			if (t[tier] === null) tiers[tier] = null;
			else if (typeof t[tier] === 'string' && usableWorkerModel(t[tier])) tiers[tier] = t[tier];
			else error(400, `${tier} must be the id of an enabled model that supports tools, or null`);
		}
	}
	if (CODE_MODES.includes(body.mode)) setSessionMode(session, body.mode);
	if (Object.keys(tiers).length) setOrchestrateModels(session.chatId, tiers);
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
