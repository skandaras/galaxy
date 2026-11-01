import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, runMigrations } from '$lib/server/db';
import { chats, messages } from '$lib/server/db/schema';
import {
	appendMessage,
	createChat,
	deleteChat,
	getChat,
	getMessages,
	listArchivedChats,
	listChats,
	recentEvidence,
	setHidden,
	updateChat
} from './chats';

/**
 * Evidence is kept beside a reply for the next turn and for nothing else: the
 * browser never receives it, only the newest replies keep it, and a hidden chat
 * holds it in memory the way it holds everything else.
 */

const USER = 'ev-user';
const page = (n: number) => [{ tool: 'fetch_url', ref: `https://e.test/${n}`, excerpt: `PAGE-TEXT-${n}` }];

beforeAll(() => {
	runMigrations();
});

beforeEach(() => {
	for (const c of [...listChats(USER), ...listArchivedChats(USER)]) deleteChat(c.id, USER);
	db.delete(messages).run();
	db.delete(chats).run();
});

function turn(chatId: string, n: number) {
	appendMessage(chatId, { role: 'user', content: `question ${n}` });
	appendMessage(chatId, { role: 'assistant', content: `answer ${n}`, evidence: page(n) });
}

describe('evidence on a reply', () => {
	it('never reaches what the browser is sent', () => {
		const chat = createChat({ userId: USER, title: 'Reading' });
		turn(chat.id, 1);
		const shown = JSON.stringify(getMessages(chat.id));
		expect(shown).not.toContain('PAGE-TEXT-1');
		expect(shown).not.toContain('evidence');
	});

	it('comes back newest first, and only the newest replies keep it', () => {
		const chat = createChat({ userId: USER, title: 'Reading' });
		for (const n of [1, 2, 3]) turn(chat.id, n);
		expect(recentEvidence(getChat(chat.id, USER)!)).toEqual([page(3), page(2)]);
		// On disk, too: the third reply back has had its copy nulled.
		const stored = db.select().from(messages).where(eq(messages.chatId, chat.id)).all();
		expect(JSON.stringify(stored)).not.toContain('PAGE-TEXT-1');
	});

	it('keeps a place for a reply that read nothing, so the one before is not taken for the last', () => {
		const chat = createChat({ userId: USER, title: 'Reading' });
		turn(chat.id, 1);
		appendMessage(chat.id, { role: 'user', content: 'thanks' });
		appendMessage(chat.id, { role: 'assistant', content: 'You are welcome.' });
		expect(recentEvidence(getChat(chat.id, USER)!)).toEqual([[], page(1)]);
	});

	it('is not replayed once compaction has folded the reply away', () => {
		const chat = createChat({ userId: USER, title: 'Reading' });
		turn(chat.id, 1);
		turn(chat.id, 2);
		updateChat(chat.id, { compactedUpTo: 2 });
		expect(recentEvidence(getChat(chat.id, USER)!)).toEqual([page(2)]);
	});

	it('lives in memory in a hidden chat, and moves both ways when the chat is hidden or shown', () => {
		const hidden = createChat({ userId: USER, title: 'Private', hidden: true });
		turn(hidden.id, 1);
		expect(db.select().from(messages).where(eq(messages.chatId, hidden.id)).all()).toEqual([]);
		expect(recentEvidence(getChat(hidden.id, USER)!)).toEqual([page(1)]);

		const open = createChat({ userId: USER, title: 'Was open' });
		turn(open.id, 7);
		setHidden(open.id, USER, true);
		// Nothing of it left on disk...
		expect(JSON.stringify(db.select().from(messages).all())).not.toContain('PAGE-TEXT-7');
		// ...but the next turn still has it, and showing the chat again puts it back.
		expect(recentEvidence(getChat(open.id, USER)!)).toEqual([page(7)]);
		setHidden(open.id, USER, false);
		expect(recentEvidence(getChat(open.id, USER)!)).toEqual([page(7)]);
	});
});
