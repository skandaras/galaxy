import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, runMigrations } from '$lib/server/db';
import { chats, messages } from '$lib/server/db/schema';
import { createChat, getChat, updateChat } from '$lib/server/chats';
import { cleanTitle, setChatTitleTool } from './chat-title';

describe('cleanTitle', () => {
	it('takes the title as given when the model behaves', () => {
		expect(cleanTitle('Postgres connection pooling')).toBe('Postgres connection pooling');
	});

	it('strips the decorations models add anyway', () => {
		// All observed in practice despite asking for "the title alone".
		expect(cleanTitle('"Nebula formation"')).toBe('Nebula formation');
		expect(cleanTitle('Title: Deploy checklist')).toBe('Deploy checklist');
		expect(cleanTitle('“Curly quoted”')).toBe('Curly quoted');
		expect(cleanTitle('Rate limiting strategies.')).toBe('Rate limiting strategies');
	});

	it('strips them when they are combined, which is the common case', () => {
		// Testing quotes and prefixes only in isolation is what let `Title: …`
		// reach the sidebar: the prefix regex never matched, because the string
		// started with a quote.
		expect(cleanTitle('"Title: Mock conversation name"')).toBe('Mock conversation name');
		expect(cleanTitle('“Title — SQLite indexing”')).toBe('SQLite indexing');
		expect(cleanTitle("'Chat title: Deploy notes.'")).toBe('Deploy notes');
	});

	it('keeps only the first line, ignoring any commentary after it', () => {
		expect(cleanTitle('SQLite indexing\n\nThis title covers the discussion of…')).toBe(
			'SQLite indexing'
		);
	});

	it('bounds the length, so one bad reply cannot fill the list', () => {
		expect(cleanTitle('x'.repeat(200))).toHaveLength(60);
	});

	it('returns empty for a reply with nothing usable in it', () => {
		expect(cleanTitle('')).toBe('');
		expect(cleanTitle('   \n  ')).toBe('');
		expect(cleanTitle('""')).toBe('');
	});

	it('leaves internal punctuation alone', () => {
		expect(cleanTitle('CI: green, then red')).toBe('CI: green, then red');
	});
});


describe('set_chat_title', () => {
	const USER = 'u1';

	beforeAll(() => {
		runMigrations();
	});
	beforeEach(() => {
		db.delete(messages).run();
		db.delete(chats).run();
	});

	const toolFor = (chatId: string) => {
		let called = false;
		return { tool: setChatTitleTool(chatId, USER, () => (called = true)), was: () => called };
	};

	it('names the chat and reports back', async () => {
		const chat = createChat({ userId: USER });
		const { tool, was } = toolFor(chat.id);

		const result = await tool.execute({ title: 'Nebula formation' });
		expect(getChat(chat.id, USER)?.title).toBe('Nebula formation');
		expect(result).toContain('Nebula formation');
		// The caller uses this to know the fallback pass is unnecessary.
		expect(was()).toBe(true);
	});

	it('cleans what the model passes, same as the fallback does', async () => {
		const chat = createChat({ userId: USER });
		await toolFor(chat.id).tool.execute({ title: '"Title: SQLite indexing."' });
		expect(getChat(chat.id, USER)?.title).toBe('SQLite indexing');
	});

	it('never overwrites a name the user chose', async () => {
		const chat = createChat({ userId: USER });
		updateChat(chat.id, { title: 'My own name', titleCustom: true });
		const { tool, was } = toolFor(chat.id);

		const result = await tool.execute({ title: 'Something else' });
		expect(getChat(chat.id, USER)?.title).toBe('My own name');
		expect(result).toContain('already named');
		// Still counts as handled, so the fallback doesn't then try either.
		expect(was()).toBe(true);
	});

	it('rejects an empty or unusable title', async () => {
		const chat = createChat({ userId: USER });
		const { tool, was } = toolFor(chat.id);
		await expect(tool.execute({ title: '   ' })).rejects.toThrow(/title is required/);
		await expect(tool.execute({})).rejects.toThrow(/title is required/);
		expect(was()).toBe(false);
	});

	it('is scoped to its own chat', async () => {
		const chat = createChat({ userId: USER });
		const { tool } = toolFor(chat.id);
		// Built per turn against one chat id, so there is no argument that could
		// point it at someone else's conversation.
		expect(tool.describe?.({ title: 'x' })).toBe('x');
		await tool.execute({ title: 'Scoped' });
		expect(getChat(chat.id, USER)?.title).toBe('Scoped');
	});
});
