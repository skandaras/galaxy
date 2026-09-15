import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { setMessageFeedback } from '$lib/server/chats';

const VALUES = new Set(['up', 'down']);

/**
 * Rate one reply, or take the rating back.
 *
 * `feedback: null` clears it, which is what pressing the same thumb twice
 * sends — a rating somebody changed their mind about is worth less than no
 * rating at all, and leaving it stuck would quietly poison the only honest
 * signal the platform has about answer quality.
 *
 * Ownership lives in `setMessageFeedback`'s SQL predicate rather than here, so
 * a message that exists but is not yours answers 404 exactly as a missing one
 * does.
 */
export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	const user = requireUser(locals);
	const body = await request.json().catch(() => ({}));
	const raw = body.feedback;
	if (raw !== null && !VALUES.has(raw)) {
		error(400, 'feedback must be "up", "down" or null');
	}
	const ok = setMessageFeedback(params.id, params.messageId, user.id, raw);
	if (!ok) error(404, 'Message not found');
	return json({ feedback: raw });
};
