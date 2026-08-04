import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import {
	deleteChat,
	getChat,
	getMessages,
	setArchived,
	setHidden,
	updateChat
} from '$lib/server/chats';
import { findRunningJobForChat } from '$lib/server/engine/jobs';

export const GET: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	const chat = getChat(params.id, user.id);
	if (!chat) error(404, 'Chat not found');
	return json({
		chat,
		messages: getMessages(chat.id),
		runningJobId: findRunningJobForChat(chat.id)?.id ?? null
	});
};

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	const user = requireUser(locals);
	let chat = getChat(params.id, user.id);
	if (!chat) error(404, 'Chat not found');
	const body = await request.json().catch(() => ({}));

	if (typeof body.title === 'string' && body.title.trim()) {
		// A rename is what marks the title as the user's, so the auto-titler
		// leaves it alone from here on.
		updateChat(chat.id, { title: body.title.trim().slice(0, 120), titleCustom: true });
	}
	if (typeof body.hidden === 'boolean' && body.hidden !== chat.hidden) {
		chat = setHidden(chat.id, user.id, body.hidden) ?? chat;
	}
	if (typeof body.archived === 'boolean' && body.archived !== Boolean(chat.archivedAt)) {
		chat = setArchived(chat.id, user.id, body.archived) ?? chat;
	}
	return json(getChat(params.id, user.id));
};

export const DELETE: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	if (!deleteChat(params.id, user.id)) error(404, 'Chat not found');
	return json({ ok: true });
};
