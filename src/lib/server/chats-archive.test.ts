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
	setArchived,
	setHidden,
	updateChat
} from './chats';

const USER = 'u1';
const OTHER = 'u2';

beforeAll(() => {
	runMigrations();
});

beforeEach(() => {
	// Hidden chats live in a module-level map rather than the database, so
	// truncating tables does not clear them.
	for (const user of [USER, OTHER]) {
		for (const c of [...listChats(user), ...listArchivedChats(user)]) {
			deleteChat(c.id, user);
		}
	}
	db.delete(messages).run();
	db.delete(chats).run();
});

describe('archiving', () => {
	it('removes a chat from the list without touching its contents', () => {
		const chat = createChat({ userId: USER, title: 'Keep me' });
		appendMessage(chat.id, { role: 'user', content: 'hello' });

		setArchived(chat.id, USER, true);

		expect(listChats(USER).map((c) => c.id)).not.toContain(chat.id);
		expect(listArchivedChats(USER).map((c) => c.id)).toEqual([chat.id]);
		// The whole point: archived is not deleted, and not hidden either.
		expect(getChat(chat.id, USER)?.title).toBe('Keep me');
		expect(getMessages(chat.id)).toHaveLength(1);
	});

	it('restores a chat to the list', () => {
		const chat = createChat({ userId: USER });
		setArchived(chat.id, USER, true);
		setArchived(chat.id, USER, false);

		expect(listChats(USER).map((c) => c.id)).toEqual([chat.id]);
		expect(listArchivedChats(USER)).toHaveLength(0);
	});

	it('records when it was archived', () => {
		const chat = createChat({ userId: USER });
		const before = Date.now();
		setArchived(chat.id, USER, true);
		expect(getChat(chat.id, USER)?.archivedAt).toBeGreaterThanOrEqual(before);
	});

	it('orders the archive by when things were put away', () => {
		const older = createChat({ userId: USER, title: 'older' });
		const newer = createChat({ userId: USER, title: 'newer' });
		setArchived(older.id, USER, true);
		setArchived(newer.id, USER, true);
		// Stamped directly rather than relying on two calls landing in different
		// milliseconds — they don't, which is what made the first version of this
		// test flaky.
		db.update(chats).set({ archivedAt: new Date(1_000) }).where(eq(chats.id, older.id)).run();
		db.update(chats).set({ archivedAt: new Date(2_000) }).where(eq(chats.id, newer.id)).run();

		expect(listArchivedChats(USER).map((c) => c.title)).toEqual(['newer', 'older']);
	});

	it('is owner-scoped, like every other chat mutation', () => {
		const chat = createChat({ userId: USER });
		expect(setArchived(chat.id, OTHER, true)).toBeNull();
		expect(listChats(USER)).toHaveLength(1);
	});

	it('works on a hidden chat without persisting it', () => {
		const chat = createChat({ userId: USER, hidden: true, title: 'Ghost' });
		setArchived(chat.id, USER, true);

		expect(listChats(USER)).toHaveLength(0);
		expect(listArchivedChats(USER).map((c) => c.title)).toEqual(['Ghost']);
		expect(db.select().from(chats).all()).toHaveLength(0);
	});

	it('survives a chat being hidden after it was archived', () => {
		const chat = createChat({ userId: USER, title: 'Both' });
		setArchived(chat.id, USER, true);
		setHidden(chat.id, USER, true);

		expect(listArchivedChats(USER).map((c) => c.title)).toEqual(['Both']);
		expect(listChats(USER)).toHaveLength(0);
	});
});

describe('title ownership', () => {
	it('starts out not custom, so the auto-titler may name it', () => {
		expect(createChat({ userId: USER }).titleCustom).toBe(false);
	});

	it('treats a chat created with a title as already named', () => {
		// Coding sessions are named after the repository and board hand-offs after
		// the card. Both were being renamed by the auto-titler on the first reply.
		const chat = createChat({ userId: USER, title: 'Card: Book plumber' });
		expect(chat.titleCustom).toBe(true);
		// Read back, not just returned: the insert used to omit the column, so the
		// object said one thing and the stored row said another.
		expect(getChat(chat.id, USER)?.titleCustom).toBe(true);
	});

	it('remembers that a human named it', () => {
		const chat = createChat({ userId: USER });
		updateChat(chat.id, { title: 'My name for it', titleCustom: true });

		const fresh = getChat(chat.id, USER)!;
		expect(fresh.title).toBe('My name for it');
		expect(fresh.titleCustom).toBe(true);
	});

	it('lets the titler set a name without claiming it as the user’s', () => {
		const chat = createChat({ userId: USER });
		updateChat(chat.id, { title: 'Agent-written title' });
		expect(getChat(chat.id, USER)?.titleCustom).toBe(false);
	});
});
