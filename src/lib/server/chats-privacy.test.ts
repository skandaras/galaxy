import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, runMigrations } from '$lib/server/db';
import {
	attachments,
	chats,
	events,
	jobs,
	messages,
	notifications,
	profileEntries,
	profileProposals,
	usageLog
} from '$lib/server/db/schema';
import { rmSync } from 'node:fs';
import {
	addAttachment,
	appendMessage,
	createChat,
	deleteChat,
	getMessages,
	listAttachments,
	listChats,
	setHidden
} from './chats';
import { emitEvent } from './engine/events';
import { recentRuns } from './engine/run-history';
import { addEntry, applyLearned, saveProposals, wipeProfile } from './profile';

/**
 * What hiding a chat is supposed to mean, asserted against the tables that used
 * to keep the receipts.
 *
 * `setHidden` deleted the messages, the attachments and the chat row, and left
 * everything else: the Observatory events, the job rows, the notification a
 * failed run leaves behind, and `usage_log.chat_id`. AGENTS.md says the id "must
 * not survive in `usage_log` or in stored `events`", and `usage.ts` says the same
 * in its own doc comment — so this is the rule the codebase already claimed to
 * follow, written down as a test that can fail.
 *
 * The existing suite only ever covered a chat created hidden, which never writes
 * any of these rows in the first place. Everything here is about the transition.
 */

const USER = 'u-priv';

beforeAll(() => runMigrations());

beforeEach(() => {
	for (const c of listChats(USER)) deleteChat(c.id, USER);
	for (const t of [messages, attachments, chats, events, jobs, notifications, usageLog]) {
		db.delete(t).run();
	}
	wipeProfile(USER);
	db.delete(profileProposals).run();
});

/** A chat that has been used: messages, a run, its events and its spending. */
function usedChat(title = 'Visible while it lasted') {
	const chat = createChat({ userId: USER, title });
	appendMessage(chat.id, { role: 'user', content: 'the question' });
	appendMessage(chat.id, { role: 'assistant', content: 'the answer' });

	const jobId = 'job-1';
	db.insert(jobs)
		.values({
			id: jobId,
			chatId: chat.id,
			userId: USER,
			task: 'chat',
			status: 'done',
			createdAt: new Date()
		})
		.run();
	emitEvent({
		userId: USER,
		chatId: chat.id,
		task: 'chat',
		type: 'tool.call',
		name: 'web_search',
		status: 'ok',
		detail: { summary: 'searched for something revealing' }
	});
	db.insert(notifications)
		.values({
			id: 'note-1',
			userId: USER,
			kind: 'turn-failed',
			title: 'A run failed while you were away',
			body: '',
			link: `/chat?chat=${chat.id}`,
			entityId: jobId,
			urgent: false,
			createdAt: new Date()
		})
		.run();
	db.insert(usageLog)
		.values({
			id: 'usage-1',
			ts: new Date(),
			userId: USER,
			chatId: chat.id,
			task: 'chat',
			modelKey: 'mock',
			promptTokens: 1_000,
			completionTokens: 100,
			costUsd: 0.25,
			status: 'ok'
		})
		.run();
	return chat;
}

describe('hiding a chat that was visible', () => {
	it('takes the whole trail with it', () => {
		const chat = usedChat();
		setHidden(chat.id, USER, true);

		expect(db.select().from(events).where(eq(events.chatId, chat.id)).all()).toHaveLength(0);
		expect(db.select().from(jobs).where(eq(jobs.chatId, chat.id)).all()).toHaveLength(0);
		expect(db.select().from(notifications).all()).toHaveLength(0);
		expect(db.select().from(messages).where(eq(messages.chatId, chat.id)).all()).toHaveLength(0);
		expect(db.select().from(chats).where(eq(chats.id, chat.id)).all()).toHaveLength(0);
	});

	it('keeps the spending and drops only the identifier', () => {
		const chat = usedChat();
		setHidden(chat.id, USER, true);

		const rows = db.select().from(usageLog).all();
		expect(rows).toHaveLength(1);
		expect(rows[0].chatId).toBeNull();
		// The money was spent whether or not the conversation is on the record;
		// deleting the row would hand budget back that the cap already counted.
		expect(rows[0].costUsd).toBe(0.25);
		expect(rows[0].promptTokens).toBe(1_000);
	});

	it('leaves the id nowhere a query could find it', () => {
		const chat = usedChat();
		setHidden(chat.id, USER, true);

		const everything = JSON.stringify([
			db.select().from(events).all(),
			db.select().from(jobs).all(),
			db.select().from(notifications).all(),
			db.select().from(usageLog).all()
		]);
		expect(everything).not.toContain(chat.id);
	});

	it('stops recentRuns reciting the runs it can no longer see', () => {
		const chat = usedChat();
		// The tool is registered on every chat turn, so this is the agent's own
		// view of a conversation the person has just hidden.
		expect(recentRuns(chat.id).length).toBeGreaterThan(0);
		setHidden(chat.id, USER, true);
		expect(recentRuns(chat.id)).toHaveLength(0);
	});

	it('says which files it could not carry over', () => {
		// The copy into memory is guarded on the file existing, and the erase
		// that follows is not — so an attachment whose bytes had already gone
		// was dropped from the hidden chat with nothing said, its id still live
		// in the message markdown. Hiding still has to succeed; it just must not
		// claim the conversation came through whole.
		const chat = usedChat('Missing bytes');
		const ref = addAttachment(chat.id, {
			name: 'gone.png',
			mime: 'image/png',
			data: Buffer.from('bytes'),
			kind: 'image'
		});
		const kept = addAttachment(chat.id, {
			name: 'here.png',
			mime: 'image/png',
			data: Buffer.from('bytes'),
			kind: 'image'
		});
		const row = db.select().from(attachments).where(eq(attachments.id, ref.id)).get()!;
		rmSync(row.path);

		const result = setHidden(chat.id, USER, true)!;
		expect(result.dropped).toEqual(['gone.png']);
		expect(result.meta.hidden).toBe(true);
		// And the one that was still there came along.
		expect(listAttachments(chat.id).map((a) => a.id)).toEqual([kept.id]);
	});

	it('is a faithful round trip', () => {
		const chat = usedChat('Round trip');
		setHidden(chat.id, USER, true);
		expect(getMessages(chat.id).map((m) => m.content)).toEqual(['the question', 'the answer']);

		setHidden(chat.id, USER, false);
		const restored = getMessages(chat.id);
		expect(restored.map((m) => m.content)).toEqual(['the question', 'the answer']);
		expect(db.select().from(chats).where(eq(chats.id, chat.id)).all()).toHaveLength(1);
		// The trail is not resurrected — it was erased, not stashed.
		expect(db.select().from(events).where(eq(events.chatId, chat.id)).all()).toHaveLength(0);
	});
});

describe('deleting a chat', () => {
	it('takes the same trail, so the two paths cannot diverge', () => {
		const chat = usedChat('Delete me');
		deleteChat(chat.id, USER);

		expect(db.select().from(events).all()).toHaveLength(0);
		expect(db.select().from(jobs).all()).toHaveLength(0);
		expect(db.select().from(notifications).all()).toHaveLength(0);
		expect(db.select().from(usageLog).all()[0].chatId).toBeNull();
	});
});

describe('what the profile learned from a chat', () => {
	/** One entry and one applied proposal quoting this chat, and one watched line from it. */
	function learnedFrom(chatId: string, messageId: string) {
		const kept = addEntry(
			USER,
			{ domain: 'work', subdomain: 'tools', kind: 'fact', claim: 'Uses Neovim daily.', quote: 'I use neovim', messageId },
			{ source: 'inferred' }
		).entry;
		const applied = applyLearned(USER, {
			source: 'test',
			action: 'add',
			path: 'work/tools',
			claim: 'Uses Docker at work.',
			quote: 'we run docker',
			messageId
		})!;
		saveProposals(
			USER,
			[{ source: 'test', action: 'add', path: 'work/tools', claim: 'Uses Emacs at home.', quote: 'emacs', messageId }],
			new Date(),
			'watching'
		);
		return { chatId, kept, applied };
	}

	const rows = () => ({
		entries: db.select().from(profileEntries).all(),
		proposals: db.select().from(profileProposals).all()
	});

	it.each([
		['hiding', (id: string) => setHidden(id, USER, true)],
		['deleting', (id: string) => deleteChat(id, USER)]
	])('%s it scrubs the quote and message id but keeps the claim', (_how, erase) => {
		const chat = usedChat();
		const msgId = getMessages(chat.id)[0].id;
		const { kept, applied } = learnedFrom(chat.id, msgId);
		// A line from another conversation is not touched.
		const other = addEntry(
			USER,
			{ domain: 'work', subdomain: 'tools', kind: 'fact', claim: 'Uses Helix on weekends.', quote: 'helix', messageId: 'm-elsewhere' },
			{ source: 'inferred' }
		).entry;

		erase(chat.id);

		const { entries, proposals } = rows();
		expect(entries.find((e) => e.id === kept.id)).toMatchObject({ claim: 'Uses Neovim daily.', quote: null, messageId: null });
		const appliedNow = proposals.find((p) => p.id === applied.id)!;
		expect(appliedNow).toMatchObject({ status: 'approved', claim: 'Uses Docker at work.', quote: null, messageId: null });
		// The entry the proposal wrote is scrubbed too.
		expect(entries.find((e) => e.id === applied.appliedEntryId)).toMatchObject({ claim: 'Uses Docker at work.', quote: null, messageId: null });
		expect(entries.find((e) => e.id === other.id)).toMatchObject({ quote: 'helix', messageId: 'm-elsewhere' });
		// Nothing left to hold the words: the watched line is gone with the chat.
		expect(proposals.filter((p) => p.status === 'watching')).toEqual([]);
		expect(JSON.stringify(rows())).not.toContain(msgId);
	});
});
