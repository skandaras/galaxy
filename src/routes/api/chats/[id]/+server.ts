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
import { findRunningJobForChat, jobAgeMinutes } from '$lib/server/engine/jobs';
import { resolveOpened } from '$lib/server/notifications';

export const GET: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	const chat = getChat(params.id, user.id);
	if (!chat) error(404, 'Chat not found');
	// Opening the chat an alert pointed at *is* dealing with it. A read on a GET
	// is deliberate: this endpoint is only ever called because someone opened
	// the conversation, which is exactly the engagement we are clearing on.
	resolveOpened(user.id, chat.id);
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
		// Refused mid-run, because `persist` is captured once when the run starts
		// (engine.ts) and never re-read. A run that began visible therefore carries
		// on writing events, job rows and a usage chat id after the flip, and bakes
		// the conversation into cortex edge weights on the way out — the one thing
		// hiding is supposed to prevent. Making `persist` live would mean threading
		// it through every closure in the loop; refusing is honest and costs the
		// user one click.
		const running = findRunningJobForChat(chat.id);
		if (running) {
			const mins = jobAgeMinutes(running);
			error(409, {
				message: `A reply started ${mins < 1 ? 'moments' : `${mins} minute${mins === 1 ? '' : 's'}`} ago is still running for this chat. Stop it first — visibility cannot change while a run is recording.`,
				jobId: running.id,
				task: running.task,
				ageMinutes: mins
			});
		}
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
