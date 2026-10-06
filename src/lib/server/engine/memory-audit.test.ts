import { ADMIN_PATHS } from '$lib/admin-sections';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { db, runMigrations } from '$lib/server/db';
import {
	chats,
	libraryDocs,
	memoryItems,
	memoryProposals,
	messages,
	skillCandidates
} from '$lib/server/db/schema';
import { appendMessage, createChat } from '$lib/server/chats';
import { findDocByTitle, saveDoc } from '$lib/server/library';
import { DEFAULT_MEMORY, setSetting } from '$lib/server/settings';
import type { RebuildStatus } from './memory';

/**
 * The audit and the rebuild, which only ever propose.
 *
 * The audit used to write memories straight into the set, with a ceiling a new
 * one had to displace something to get under. Every change now waits for the
 * person, so what these hold down is that nothing an agent returns reaches
 * `memory_items`, that the queue stays bounded, and that what a person has
 * turned down stays turned down.
 */

let reply = '{}';
let thrown: Error | null = null;
let requests: { messages: { role: string; content: string }[] }[] = [];

vi.mock('./engine', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./engine')>();
	return {
		...actual,
		getTaskConfig: (task: string) =>
			task === 'memory'
				? {
						task,
						systemPrompt: 'you remember',
						promptOverride: 'you remember',
						primaryModelId: 'm-mem'
					}
				: actual.getTaskConfig(task),
		pickModel: () => ({
			model: {
				id: 'm-mem',
				modelKey: 'mock/mem',
				displayName: 'Mem',
				supportsReasoning: false,
				reasoningMode: 'auto',
				promptCostPerMTok: null,
				completionCostPerMTok: null
			},
			provider: {},
			adapter: {
				complete: async (req: { messages: { role: string; content: string }[] }) => {
					requests.push(req);
					if (thrown) throw thrown;
					return {
						text: typeof reply === 'string' ? reply : '{}',
						usage: { promptTokens: 10, completionTokens: 5 }
					};
				}
			}
		})
	};
});

const { getMemoryStatus, runMemory, startRebuild } = await import('./memory');

const ALICE = 'u-alice';
const BOB = 'u-bob';
const CAP = 5;

beforeAll(() => runMigrations());

beforeEach(() => {
	for (const t of [memoryItems, memoryProposals, skillCandidates, libraryDocs, messages, chats]) {
		db.delete(t).run();
	}
	db.run(sql`DELETE FROM library_fts`);
	setSetting('memory', { ...DEFAULT_MEMORY, maxItems: CAP });
	setSetting('memory.watermark', 0, ALICE);
	reply = '{}';
	thrown = null;
	requests = [];
});

/** Something for the audit to read, or it skips before reaching a model. */
function activity(userId = ALICE, said = 'I always want diffs kept minimal') {
	const chat = createChat({ userId, title: 'Something happened' });
	appendMessage(chat.id, { role: 'user', content: said });
	return chat;
}

function remember(content: string, userId = ALICE, createdAt = new Date(), title = '') {
	const id = `${userId}-${content}-${createdAt.getTime()}`;
	db.insert(memoryItems)
		.values({
			id,
			userId,
			kind: 'pattern',
			title,
			content,
			source: 'test',
			status: 'active',
			createdAt
		})
		.run();
	return id;
}

/** A set, oldest first so the numbering in the prompt is predictable. */
function fillTo(n: number, userId = ALICE) {
	const ids: string[] = [];
	for (let i = 0; i < n; i++) {
		ids.push(remember(`memory ${i}`, userId, new Date(1_000_000 + i * 1000)));
	}
	return ids;
}

const items = (userId = ALICE) =>
	db.select().from(memoryItems).where(eq(memoryItems.userId, userId)).all();
const pending = (userId = ALICE) =>
	db
		.select()
		.from(memoryProposals)
		.where(and(eq(memoryProposals.userId, userId), eq(memoryProposals.status, 'pending')))
		.all();
const promptOf = () => String(requests.at(-1)?.messages.at(-1)?.content ?? '');
const add = (title: string, content = `${title}, in full`, kind = 'preference') => ({
	kind,
	title,
	content,
	why: 'seen twice'
});

describe('the audit', () => {
	it('proposes, and changes nothing the person holds', async () => {
		activity();
		const held = fillTo(2);
		reply = JSON.stringify({
			add: [add('Minimal diffs')],
			update: [{ item: 1, title: 'Renamed', content: 'reworded', why: 'clearer' }],
			retire: [{ item: 2, why: 'no longer true' }]
		});
		const res = await runMemory('manual', ALICE);

		expect(res).toMatchObject({ ran: true, proposals: 3 });
		expect(items().map((m) => m.id).sort()).toEqual([...held].sort());
		expect(items().every((m) => m.status === 'active' && m.title === '')).toBe(true);
		expect(pending().map((p) => p.action).sort()).toEqual(['add', 'retire', 'update']);
	});

	it('resolves numbers to the list it showed, newest first', async () => {
		activity();
		const [oldest, newest] = fillTo(2);
		reply = JSON.stringify({ retire: [{ item: 1, why: 'x' }] });
		await runMemory('manual', ALICE);
		expect(pending()[0].itemId).toBe(newest);
		expect(pending()[0].itemId).not.toBe(oldest);
	});

	it('ignores a number that names nothing', async () => {
		activity();
		fillTo(2);
		reply = JSON.stringify({ retire: [{ item: 9 }, { item: 0 }, { item: '1' }] });
		await runMemory('manual', ALICE);
		expect(pending()).toHaveLength(0);
	});

	it('proposes no facts: an addition with no kind it may hold is dropped', async () => {
		activity();
		reply = JSON.stringify({
			add: [add('Works at Acme', 'Works at Acme', 'fact'), add('Minimal diffs')]
		});
		await runMemory('manual', ALICE);
		expect(pending().map((p) => p.title)).toEqual(['Minimal diffs']);
	});

	it('counts what is waiting against the ceiling, not only what is held', async () => {
		activity();
		fillTo(CAP - 2);
		reply = JSON.stringify({ add: [add('One'), add('Two')] });
		await runMemory('manual', ALICE);
		expect(pending()).toHaveLength(2);

		// The set is not full, but the queue would fill it: nothing more fits.
		activity();
		reply = JSON.stringify({ add: [add('Three')] });
		await runMemory('manual', ALICE);
		expect(pending()).toHaveLength(2);
		expect(promptOf()).toContain('There is no room for anything new');
	});

	it('raises at most eight proposals in one run', async () => {
		setSetting('memory', { ...DEFAULT_MEMORY, maxItems: 50 });
		activity();
		reply = JSON.stringify({ add: Array.from({ length: 12 }, (_, i) => add(`Pattern ${i}`)) });
		await runMemory('manual', ALICE);
		expect(pending()).toHaveLength(8);
	});

	it('does not propose a second change to a memory that already has one waiting', async () => {
		activity();
		fillTo(1);
		reply = JSON.stringify({ retire: [{ item: 1, why: 'x' }] });
		await runMemory('manual', ALICE);
		activity();
		reply = JSON.stringify({ update: [{ item: 1, title: 'T', content: 'c' }] });
		await runMemory('manual', ALICE);
		expect(pending()).toHaveLength(1);
		expect(promptOf()).toContain('a change is already waiting on this one');
	});

	it('will not propose again what the person turned down', async () => {
		activity();
		db.insert(memoryProposals)
			.values({
				id: 'rejected-1',
				userId: ALICE,
				action: 'add',
				kind: 'preference',
				title: 'Likes long answers',
				content: 'Likes long answers',
				status: 'rejected',
				createdAt: new Date()
			})
			.run();
		reply = JSON.stringify({ add: [add('likes long answers')] });
		await runMemory('manual', ALICE);
		expect(promptOf()).toContain('Likes long answers');
		expect(pending()).toHaveLength(0);
	});

	it('shows recent dismissals as never again, and only recent ones', async () => {
		activity();
		for (let i = 0; i < 60; i++) {
			const id = remember(`dismissed ${i}`, ALICE, new Date(2_000_000 + i * 1000));
			db.update(memoryItems).set({ status: 'archived' }).where(eq(memoryItems.id, id)).run();
		}
		await runMemory('manual', ALICE);
		expect(promptOf()).toContain('dismissed 59');
		expect(promptOf()).not.toContain('dismissed 0:');
	});

	it('reads only its own person', async () => {
		activity(BOB, 'Bob says something private');
		activity(ALICE);
		fillTo(1, BOB);
		await runMemory('manual', ALICE);
		expect(promptOf()).not.toContain('Bob says something private');
		expect(promptOf()).not.toContain('memory 0');
	});

	it('says which limit it hit and leaves the watermark where it was', async () => {
		activity();
		const before = getMemoryStatus(ALICE).watermark;
		thrown = Object.assign(new Error('The operation was aborted due to timeout'), {
			name: 'TimeoutError'
		});
		const res = await runMemory('manual', ALICE);

		expect(res.ran).toBe(false);
		expect(res.reason).toMatch(/did not answer within the 180s/);
		expect(res.reason).toContain(ADMIN_PATHS.memory);
		expect(getMemoryStatus(ALICE).watermark).toBe(before);
	});
});

describe('wipe and rebuild', () => {
	const rebuild = () =>
		new Promise<RebuildStatus>((resolve, reject) => {
			const res = startRebuild(ALICE, resolve);
			if (!res.started) reject(new Error(res.reason));
		});

	it('clears everything first, the old long-term document included', async () => {
		fillTo(3);
		db.insert(memoryProposals)
			.values({ id: 'p', userId: ALICE, action: 'add', title: 't', content: 'c', createdAt: new Date() })
			.run();
		saveDoc({ title: 'Long term user memory', body: 'old', author: 'agent', ownerId: ALICE });
		fillTo(2, BOB);

		await rebuild();
		expect(items()).toHaveLength(0);
		expect(findDocByTitle('Long term user memory', ALICE)).toBeNull();
		// Someone else's memory is theirs.
		expect(items(BOB)).toHaveLength(2);
	});

	it('reads every conversation, a window at a time, newest first', async () => {
		for (let i = 0; i < 14; i++) activity(ALICE, `conversation number ${i}`);
		const status = await rebuild();

		expect(status).toMatchObject({ running: false, total: 3, done: 3, failed: 0 });
		const read = requests.map((r) => String(r.messages.at(-1)?.content ?? ''));
		expect(read).toHaveLength(3);
		expect(read[0]).toContain('This is a rebuild');
		// Every conversation was read, by one window or another. The newline is
		// what stops "number 1" matching "number 10".
		const all = read.join('\n');
		for (let i = 0; i < 14; i++) expect(all).toContain(`conversation number ${i}\n`);
		// Newest first: the last conversation started is in the first window.
		expect(read[0]).toContain('conversation number 13\n');
	});

	it('puts what it finds in the queue, and carries the watermark forward', async () => {
		activity();
		reply = JSON.stringify({ add: [add('Minimal diffs')] });
		const status = await rebuild();
		expect(status.proposals).toBe(1);
		expect(pending().map((p) => p.title)).toEqual(['Minimal diffs']);
		expect(items()).toHaveLength(0);
		expect(getMemoryStatus(ALICE).watermark).toBe(status.startedAt);
	});

	it('keeps going when one window fails', async () => {
		for (let i = 0; i < 8; i++) activity(ALICE, `c${i}`);
		thrown = new Error('provider fell over');
		const status = await rebuild();
		expect(status).toMatchObject({ total: 2, done: 2, failed: 2 });
	});

	it('leaves a person with no history with nothing', async () => {
		fillTo(2);
		const status = await rebuild();
		expect(status).toMatchObject({ total: 0, done: 0 });
		expect(items()).toHaveLength(0);
		expect(requests).toHaveLength(0);
	});
});
