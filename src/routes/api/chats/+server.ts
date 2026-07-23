import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { createChat, listChats } from '$lib/server/chats';

export const GET: RequestHandler = ({ locals }) => {
	const user = requireUser(locals);
	return json(listChats(user.id));
};

export const POST: RequestHandler = async ({ locals, request }) => {
	const user = requireUser(locals);
	const body = await request.json().catch(() => ({}));
	const chat = createChat({
		userId: user.id,
		mode: body.mode === 'code' ? 'code' : 'chat',
		hidden: Boolean(body.hidden)
	});
	return json(chat, { status: 201 });
};
