import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

	it('records when it was archived, and orders the archive by that', () => {
		const first = createChat({ userId: USER, title: 'first' });
		const second = createChat({ userId: USER, title: 'second' });
		setArchived(first.id, USER, true);
		setArchived(second.id, USER, true);

		expect(listArchivedChats(USER).map((c) => c.title)).toEqual(['second', 'first']);
		expect(getChat(first.id, USER)?.archivedAt).toBeGreaterThan(0);
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
