import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { createChat, listArchivedChats, listChats } from '$lib/server/chats';

/**
 * Active chats, or the archive with `?archived=1`.
 *
 * A query parameter rather than a richer response body: this endpoint is also
 * what the Code page reads, and it consumes the array directly.
 */
export const GET: RequestHandler = ({ locals, url }) => {
	const user = requireUser(locals);
	return json(
		url.searchParams.get('archived') === '1' ? listArchivedChats(user.id) : listChats(user.id)
	);
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
