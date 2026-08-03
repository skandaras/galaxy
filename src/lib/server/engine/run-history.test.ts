import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { db, runMigrations } from '$lib/server/db';
import { chats, events, jobs, messages } from '$lib/server/db/schema';
import { formatRunHistory, previousRunNote, recentRuns } from './run-history';

const CHAT = 'chat-1';
const OTHER = 'chat-2';
const NOW = Date.UTC(2026, 7, 3, 12, 0);
const minsAgo = (n: number) => new Date(NOW - n * 60_000);

beforeAll(() => {
	runMigrations();
});

beforeEach(() => {
	db.delete(jobs).run();
	db.delete(events).run();
	db.delete(messages).run();
	db.delete(chats).run();
});

/** The turn event the loop writes on the way out, carrying why it stopped. */
function turnEvent(stopReason: string, minsAgo: number, chatId = CHAT) {
	db.insert(events)
		.values({
			id: randomUUID(),
			ts: new Date(NOW - minsAgo * 60_000),
			userId: 'u1',
			chatId,
			task: 'chat',
			type: 'job',
			name: 'chat.turn',
			status: 'ok',
			durationMs: 900,
			detail: { stopReason, steps: 3 }
		})
		.run();
}

function reply(content: string, minsAgo: number) {
	db.insert(chats)
		.values({
			id: CHAT,
			userId: 'u1',
			mode: 'chat',
			title: 't',
			createdAt: minsAgo2(minsAgo + 1),
			updatedAt: minsAgo2(minsAgo)
		})
		.onConflictDoNothing()
		.run();
	db.insert(messages)
		.values({
			id: randomUUID(),
			chatId: CHAT,
			seq: db.select().from(messages).all().length,
			role: 'assistant',
			content,
			createdAt: minsAgo2(minsAgo)
		})
		.run();
}
const minsAgo2 = (n: number) => new Date(NOW - n * 60_000);

function run(opts: {
	chatId?: string;
	status: 'done' | 'error' | 'cancelled' | 'running';
	error?: string;
	startedMinsAgo: number;
	took?: number;
}): string {
	const id = randomUUID();
	db.insert(jobs)
		.values({
			id,
			chatId: opts.chatId ?? CHAT,
			userId: 'u1',
			task: 'chat',
			status: opts.status,
			error: opts.error ?? null,
			createdAt: minsAgo(opts.startedMinsAgo),
			finishedAt: opts.status === 'running' ? null : minsAgo(opts.startedMinsAgo - (opts.took ?? 1))
		})
		.run();
	return id;
}

function toolEvent(opts: {
	name: string;
	status: 'ok' | 'error';
	minsAgo: number;
	detail?: Record<string, unknown>;
	chatId?: string;
}) {
	db.insert(events)
		.values({
			id: randomUUID(),
			ts: minsAgo(opts.minsAgo),
			userId: 'u1',
			chatId: opts.chatId ?? CHAT,
			task: 'chat',
			type: 'tool.call',
			name: opts.name,
			status: opts.status,
			durationMs: 120,
			detail: opts.detail ?? {}
		})
		.run();
}

describe('recentRuns', () => {
	it('returns this chat’s runs, newest first', () => {
		run({ status: 'done', startedMinsAgo: 30 });
		run({ status: 'error', startedMinsAgo: 10 });
		run({ chatId: OTHER, status: 'done', startedMinsAgo: 5 });

		const runs = recentRuns(CHAT);
		expect(runs).toHaveLength(2);
		expect(runs[0].status).toBe('error');
	});
});

describe('previousRunNote', () => {
	it('says nothing when the last run finished normally', () => {
		run({ status: 'done', startedMinsAgo: 5 });
		turnEvent('complete', 4);
		reply('Here is your answer.', 4);
		expect(previousRunNote(CHAT, NOW)).toBe('');
	});

	it('flags a run that ran out of steps, though it counts as done', () => {
		// The user gets a partial answer and no indication it was cut short.
		run({ status: 'done', startedMinsAgo: 6 });
		turnEvent('exhausted', 5);
		reply('I started on it…', 5);

		const note = previousRunNote(CHAT, NOW);
		expect(note).toContain('used up its step budget');
		expect(note).toContain('Continue from where it got to');
	});

	it('flags a run the spend cap cut off', () => {
		run({ status: 'done', startedMinsAgo: 6 });
		turnEvent('budget', 5);
		reply('Partial…', 5);
		expect(previousRunNote(CHAT, NOW)).toContain('spend cap');
	});

	it('flags a run that answered with nothing at all', () => {
		// Recorded as a success, saved as an empty message: the exact shape of
		// "it just didn't reply", and previously invisible to the next turn.
		run({ status: 'done', startedMinsAgo: 3 });
		turnEvent('complete', 2);
		reply('   ', 2);

		expect(previousRunNote(CHAT, NOW)).toContain('empty reply');
	});

	it('says nothing when there is no history at all', () => {
		expect(previousRunNote(CHAT, NOW)).toBe('');
	});

	it('reports a failure, with its reason and when', () => {
		run({ status: 'error', error: 'Model call failed: 503', startedMinsAgo: 4 });
		const note = previousRunNote(CHAT, NOW);

		expect(note).toContain('Previous attempt');
		expect(note).toContain('4 minutes ago');
		expect(note).toContain('Model call failed: 503');
		// The behaviour this exists to change.
		expect(note).toContain('Do not simply repeat that attempt');
	});

	it('lists the tool calls it managed before dying, and which failed', () => {
		run({ status: 'error', error: 'boom', startedMinsAgo: 10, took: 5 });
		toolEvent({ name: 'read_file', status: 'ok', minsAgo: 9 });
		toolEvent({ name: 'bash', status: 'error', minsAgo: 8, detail: { error: 'exit 1: no such file' } });

		const note = previousRunNote(CHAT, NOW);
		expect(note).toContain('2 tool calls');
		expect(note).toContain('bash (failed)');
		expect(note).toContain('exit 1: no such file');
	});

	it('treats a run the user stopped differently from one that broke', () => {
		run({ status: 'cancelled', startedMinsAgo: 3 });
		const note = previousRunNote(CHAT, NOW);

		expect(note).toContain('stopped by the user');
		// Resuming is right here; starting over would redo work deliberately kept,
		// which is the opposite of what a failed run needs.
		expect(note).toContain('Continue from where it got to');
		expect(note).not.toContain('Do not simply repeat');
	});

	it('clears once a later run succeeds', () => {
		run({ status: 'error', error: 'boom', startedMinsAgo: 20 });
		run({ status: 'done', startedMinsAgo: 5 });
		turnEvent('complete', 4);
		reply('All good.', 4);
		expect(previousRunNote(CHAT, NOW)).toBe('');
	});

	it('ignores the run currently in flight', () => {
		// The turn asking the question is always 'running'; describing it back
		// would make every turn look like it had just failed.
		run({ status: 'done', startedMinsAgo: 20 });
		turnEvent('complete', 19);
		reply('Done.', 19);
		run({ status: 'running', startedMinsAgo: 0 });
		expect(previousRunNote(CHAT, NOW)).toBe('');
	});

	it('never reports another conversation’s failure', () => {
		run({ chatId: OTHER, status: 'error', error: 'not yours', startedMinsAgo: 2 });
		expect(previousRunNote(CHAT, NOW)).toBe('');
	});
});

describe('run_history', () => {
	it('describes recent runs and their tool calls', () => {
		run({ status: 'error', error: 'boom', startedMinsAgo: 10, took: 4 });
		toolEvent({ name: 'web_search', status: 'ok', minsAgo: 9, detail: { summary: 'galaxy news' } });
		toolEvent({ name: 'bash', status: 'error', minsAgo: 8, detail: { error: 'exit 2' } });

		const text = formatRunHistory(CHAT, 3, NOW);
		expect(text).toContain('chat run');
		expect(text).toContain('error');
		expect(text).toContain('web_search ok');
		expect(text).toContain('galaxy news');
		expect(text).toContain('bash error');
		expect(text).toContain('exit 2');
	});

	it('explains itself when there is nothing recorded', () => {
		expect(formatRunHistory(CHAT, 3, NOW)).toContain('No earlier runs');
	});

	it('excludes the run doing the asking', () => {
		run({ status: 'running', startedMinsAgo: 0 });
		expect(formatRunHistory(CHAT, 3, NOW)).toContain('No earlier runs');
	});

	it('honours the limit', () => {
		for (let i = 1; i <= 5; i++) run({ status: 'done', startedMinsAgo: i * 10 });
		const text = formatRunHistory(CHAT, 2, NOW);
		expect(text.match(/^## /gm)).toHaveLength(2);
	});
});
