import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { createChat, listArchivedChats, listChats } from '$lib/server/chats';
import { runningChatIds } from '$lib/server/engine/jobs';

/**
 * Active chats, or the archive with `?archived=1`.
 *
 * A query parameter rather than a richer response body: this endpoint is also
 * what the Code page reads, and it consumes the array directly.
 *
 * `running` is decorated on here rather than inside listChats: whether a job is
 * in flight is engine state, and chats.ts has no business knowing about it.
 * Archived chats are never running, so the flag is only worth the lookup on the
 * active list.
 */
export const GET: RequestHandler = ({ locals, url }) => {
	const user = requireUser(locals);
	if (url.searchParams.get('archived') === '1') return json(listArchivedChats(user.id));
	const running = runningChatIds(user.id);
	return json(listChats(user.id).map((c) => ({ ...c, running: running.has(c.id) })));
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
