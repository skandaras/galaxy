import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { db, runMigrations } from '$lib/server/db';
import { chats, events, jobs, messages, usageLog, uxIdeas } from '$lib/server/db/schema';
import {
	buildAuditPrompt,
	decideUxIdea,
	fingerprint,
	getUxStatus,
	historyDigest,
	listUxIdeas,
	recordIdeas,
	telemetryDigest,
	uiDigest
} from './ux-audit';

/** A phrase that could only have come from reading a conversation. */
const SECRET = 'pineapple-audit-canary-9f3b';

beforeAll(() => {
	runMigrations();
});

beforeEach(() => {
	db.delete(uxIdeas).run();
	db.delete(events).run();
	db.delete(jobs).run();
	db.delete(usageLog).run();
	db.delete(messages).run();
	db.delete(chats).run();
});

const idea = (over: Partial<Record<string, unknown>> = {}) => ({
	title: 'Show why a coding run stopped',
	area: 'code',
	severity: 'high',
	effort: 'm',
	problem: 'Runs end with no explanation.',
	proposal: 'Surface the stop reason in the trace.',
	evidence: 'jobs: 12 cancelled runs',
	...over
});

describe('fingerprint', () => {
	it('normalises punctuation and case so a reworded repeat still collides', () => {
		expect(fingerprint('Show why a coding run stopped')).toBe('show-why-a-coding-run-stopped');
		expect(fingerprint('  SHOW why a coding run stopped!  ')).toBe(
			'show-why-a-coding-run-stopped'
		);
	});

	it('is empty for a title with nothing in it', () => {
		expect(fingerprint('!!!')).toBe('');
	});
});

describe('recordIdeas', () => {
	it('files new ideas as open', () => {
		expect(recordIdeas([idea()], 8)).toEqual({ added: 1, duplicates: 0 });
		const [row] = listUxIdeas();
		expect(row.status).toBe('open');
		expect(row.area).toBe('code');
		expect(row.severity).toBe('high');
	});

	it('drops a repeat of an idea already open', () => {
		recordIdeas([idea()], 8);
		expect(recordIdeas([idea()], 8)).toEqual({ added: 0, duplicates: 1 });
		expect(listUxIdeas()).toHaveLength(1);
	});

	it('drops a repeat of an idea the owner already decided, either way', () => {
		recordIdeas([idea({ title: 'Idea one' }), idea({ title: 'Idea two' })], 8);
		const [one, two] = listUxIdeas();
		decideUxIdea(one.id, 'actioned');
		decideUxIdea(two.id, 'discard');

		// Both are closed, so neither should come back — that is the whole point
		// of keeping decided rows forever.
		expect(recordIdeas([idea({ title: 'Idea one' }), idea({ title: 'Idea two' })], 8)).toEqual({
			added: 0,
			duplicates: 2
		});
		expect(listUxIdeas()).toHaveLength(2);
	});

	it('dedupes within a single batch', () => {
		expect(recordIdeas([idea(), idea()], 8)).toEqual({ added: 1, duplicates: 1 });
	});

	it('honours the per-run cap and skips titleless entries', () => {
		const batch = [idea({ title: 'A' }), idea({ title: 'B' }), idea({ title: 'C' })];
		expect(recordIdeas(batch, 2).added).toBe(2);
		expect(recordIdeas([{ problem: 'no title' }, null], 8)).toEqual({ added: 0, duplicates: 0 });
	});

	it('falls back to safe values for fields the model got wrong', () => {
		recordIdeas([idea({ area: 'nonsense', severity: 'catastrophic', effort: 'xl' })], 8);
		const [row] = listUxIdeas();
		expect(row.area).toBe('general');
		expect(row.severity).toBe('medium');
		expect(row.effort).toBe('m');
	});
});

describe('decideUxIdea', () => {
	it('closes an open idea and records when', () => {
		recordIdeas([idea()], 8);
		const [row] = listUxIdeas();

		const actioned = decideUxIdea(row.id, 'actioned');
		expect(actioned?.status).toBe('actioned');
		expect(actioned?.decidedAt).toBeInstanceOf(Date);
	});

	it('maps discard onto the discarded status', () => {
		recordIdeas([idea()], 8);
		expect(decideUxIdea(listUxIdeas()[0].id, 'discard')?.status).toBe('discarded');
	});

	it('refuses a second decision, and an unknown id', () => {
		recordIdeas([idea()], 8);
		const [row] = listUxIdeas();
		decideUxIdea(row.id, 'actioned');
		expect(decideUxIdea(row.id, 'discard')).toBeNull();
		expect(decideUxIdea(randomUUID(), 'discard')).toBeNull();
	});
});

describe('getUxStatus', () => {
	it('counts open separately from everything ever proposed', () => {
		recordIdeas([idea({ title: 'A' }), idea({ title: 'B' })], 8);
		decideUxIdea(listUxIdeas()[0].id, 'discard');
		const status = getUxStatus();
		expect(status.open).toBe(1);
		expect(status.total).toBe(2);
	});
});

describe('historyDigest', () => {
	it('says so plainly when nothing has been proposed', () => {
		expect(historyDigest()).toContain('nothing has been proposed');
	});

	it('replays every past idea with what became of it', () => {
		recordIdeas([idea({ title: 'Kept idea' }), idea({ title: 'Rejected idea' })], 8);
		decideUxIdea(listUxIdeas().find((i) => i.title === 'Rejected idea')!.id, 'discard');

		const text = historyDigest();
		expect(text).toContain('[open] (code) Kept idea');
		expect(text).toContain('[discarded] (code) Rejected idea');
	});
});

describe('telemetryDigest', () => {
	const since = Date.now() - 7 * 86_400_000;

	function seedActivity() {
		const chatId = randomUUID();
		db.insert(chats)
			.values({
				id: chatId,
				userId: 'u1',
				mode: 'chat',
				title: `Chat about ${SECRET}`,
				createdAt: new Date(),
				updatedAt: new Date()
			})
			.run();
		db.insert(messages)
			.values({
				id: randomUUID(),
				chatId,
				seq: 1,
				role: 'user',
				content: `Please help me with ${SECRET}`,
				createdAt: new Date()
			})
			.run();
		db.insert(jobs)
			.values({
				id: randomUUID(),
				chatId,
				userId: 'u1',
				task: 'coding',
				status: 'cancelled',
				createdAt: new Date(Date.now() - 5000),
				finishedAt: new Date()
			})
			.run();
		db.insert(events)
			.values({
				id: randomUUID(),
				ts: new Date(),
				userId: 'u1',
				chatId,
				task: 'chat',
				type: 'tool.call',
				name: 'web_search',
				status: 'error',
				durationMs: 900,
				detail: null
			})
			.run();
		db.insert(usageLog)
			.values({
				id: randomUUID(),
				ts: new Date(),
				userId: 'u1',
				chatId,
				task: 'chat',
				modelKey: 'test-model',
				promptTokens: 10,
				completionTokens: 5,
				costUsd: 0.25,
				status: 'ok'
			})
			.run();
	}

	it('summarises runs, failures, tools and activity shape', () => {
		seedActivity();
		const text = telemetryDigest(since);

		expect(text).toContain('coding · cancelled');
		expect(text).toContain('web_search');
		expect(text).toContain('1 failure(s)');
		expect(text).toContain('Conversations started: 1');
		expect(text).toContain('$0.25');
	});

	it('never includes message or chat-title content', () => {
		seedActivity();
		expect(telemetryDigest(since)).not.toContain(SECRET);
	});

	it('is stable with no activity at all', () => {
		expect(() => telemetryDigest(since)).not.toThrow();
		expect(telemetryDigest(since)).toContain('Window:');
	});
});

describe('uiDigest', () => {
	it('reads the interface source, which is not on disk in production', async () => {
		const text = await uiDigest();
		expect(text).toContain('/src/routes/chat/+page.svelte');
		expect(text).toContain('composer');
	});

	it('stops at the character budget and says what it left out', async () => {
		const text = await uiDigest(2_000);
		// The budget bounds the source, not the "omitted" footer that follows it.
		expect(text).toContain('further file(s) omitted');
		expect(text.length).toBeLessThan(20_000);
	});

	it('puts the two daily-use surfaces first', async () => {
		const text = await uiDigest(6_000);
		const chatAt = text.indexOf('/src/routes/chat/+page.svelte');
		const libraryAt = text.indexOf('/src/routes/library/+page.svelte');
		expect(chatAt).toBeGreaterThanOrEqual(0);
		expect(chatAt).toBeLessThan(libraryAt === -1 ? Infinity : libraryAt);
	});
});

describe('buildAuditPrompt', () => {
	it('carries all three sections', async () => {
		const prompt = await buildAuditPrompt({ since: Date.now() - 86_400_000, maxIdeas: 5 });
		expect(prompt).toContain('ALREADY PROPOSED');
		expect(prompt).toContain('USAGE TELEMETRY');
		expect(prompt).toContain('INTERFACE SOURCE');
		expect(prompt).toContain('at most 5 ideas');
	});

	it('never carries conversation content', async () => {
		const chatId = randomUUID();
		db.insert(chats)
			.values({
				id: chatId,
				userId: 'u1',
				mode: 'chat',
				title: SECRET,
				createdAt: new Date(),
				updatedAt: new Date()
			})
			.run();
		db.insert(messages)
			.values({
				id: randomUUID(),
				chatId,
				seq: 1,
				role: 'user',
				content: SECRET,
				createdAt: new Date()
			})
			.run();

		const prompt = await buildAuditPrompt({ since: Date.now() - 86_400_000, maxIdeas: 5 });
		expect(prompt).not.toContain(SECRET);
	});
});
