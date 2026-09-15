import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, runMigrations } from '$lib/server/db';
import { chats, messages } from '$lib/server/db/schema';
import { appendMessage, createChat, getMessages, setMessageFeedback } from './chats';

/**
 * The only direct signal the platform has about whether an answer was any good.
 *
 * Every other quality signal here is a proxy — a retry, a cancel, a run that
 * ended early — and a proxy cannot tell a reply that was slow from one that was
 * wrong. These pin the two things that make it trustworthy: it belongs to the
 * person whose chat it is, and it cannot be attached to a question.
 */

beforeAll(() => runMigrations());

beforeEach(() => {
	db.delete(messages).run();
	db.delete(chats).run();
});

const reply = (userId: string) => {
	const chat = createChat({ userId });
	appendMessage(chat.id, { role: 'user', content: 'why is my CPU busy' });
	const msg = appendMessage(chat.id, { role: 'assistant', content: 'Here is why.' });
	return { chat, msg };
};

describe('setMessageFeedback', () => {
	it('records a rating on a reply', () => {
		const { chat, msg } = reply('ana');
		expect(setMessageFeedback(chat.id, msg.id, 'ana', 'down')).toBe(true);
		expect(getMessages(chat.id).find((m) => m.id === msg.id)?.feedback).toBe('down');
	});

	it('takes one back', () => {
		// Pressing the same thumb twice. A rating somebody changed their mind
		// about is worth less than no rating at all.
		const { chat, msg } = reply('ana');
		setMessageFeedback(chat.id, msg.id, 'ana', 'up');
		expect(setMessageFeedback(chat.id, msg.id, 'ana', null)).toBe(true);
		expect(getMessages(chat.id).find((m) => m.id === msg.id)?.feedback).toBeNull();
	});

	it('starts null, which means nothing was said rather than the reply was fine', () => {
		const { chat, msg } = reply('ana');
		expect(getMessages(chat.id).find((m) => m.id === msg.id)?.feedback).toBeNull();
	});

	it('refuses somebody else’s chat, and changes nothing', () => {
		const { chat, msg } = reply('ana');
		expect(setMessageFeedback(chat.id, msg.id, 'bob', 'down')).toBe(false);
		expect(getMessages(chat.id).find((m) => m.id === msg.id)?.feedback).toBeNull();
	});

	it('will not rate a person’s own question', () => {
		const chat = createChat({ userId: 'ana' });
		const asked = appendMessage(chat.id, { role: 'user', content: 'why is my CPU busy' });
		expect(setMessageFeedback(chat.id, asked.id, 'ana', 'up')).toBe(false);
	});

	it('answers the same for a message that is not there', () => {
		const { chat } = reply('ana');
		expect(setMessageFeedback(chat.id, 'no-such-message', 'ana', 'up')).toBe(false);
	});

	it('cannot reach a reply in a hidden chat, because there is no row', () => {
		// Hidden chats are never written to the database, so there is nothing to
		// carry an opinion — the boundary holds by construction rather than by a
		// guard that could be forgotten.
		const chat = createChat({ userId: 'ana', hidden: true });
		const msg = appendMessage(chat.id, { role: 'assistant', content: 'Here is why.' });
		expect(setMessageFeedback(chat.id, msg.id, 'ana', 'down')).toBe(false);
		expect(getMessages(chat.id).find((m) => m.id === msg.id)?.feedback).toBeNull();
	});
});
