import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { db, runMigrations } from '$lib/server/db';
import { libraryDocs, memoryItems, skillCandidates } from '$lib/server/db/schema';
import { appendMessage, createChat } from '$lib/server/chats';
import { findDocByTitle, getDoc } from '$lib/server/library';

/**
 * The working set, and what it costs to get into it.
 *
 * `runMemory` had no coverage at all, which is part of why nobody noticed that
 * its prompt grew every time it succeeded: every active memory and every
 * dismissed one was joined into it whole, so the input was a function of how
 * long the job had been working. These are the rules that replaced that — a
 * fixed ceiling, a new memory has to displace a named one, and what leaves is
 * either filed or dropped.
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
				? { task, systemPrompt: 'you remember', primaryModelId: 'm-mem' }
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
					return { text: reply, usage: { promptTokens: 10, completionTokens: 5 } };
				}
			}
		})
	};
});

const { runMemory, memoryDigest } = await import('./memory');

const ALICE = 'u-alice';
const BOB = 'u-bob';

beforeAll(() => runMigrations());

beforeEach(() => {
	for (const t of [memoryItems, skillCandidates, libraryDocs]) db.delete(t).run();
	// FTS5 sits outside drizzle, so it is cleared by hand like the library suites do.
	db.run(sql`DELETE FROM library_fts`);
	reply = '{}';
	thrown = null;
	requests = [];
});

/** Something for the audit to read, or it skips before reaching a model. */
function activity(userId = ALICE) {
	const chat = createChat({ userId, title: 'Something happened' });
	appendMessage(chat.id, { role: 'user', content: 'I always want diffs kept minimal' });
	return chat;
}

function remember(content: string, userId = ALICE, createdAt = new Date()) {
	const id = `${userId}-${content}-${createdAt.getTime()}`;
	db.insert(memoryItems)
		.values({ id, userId, kind: 'fact', content, source: 'test', status: 'active', createdAt })
		.run();
	return id;
}

/** A full set, oldest first so the numbering in the prompt is predictable. */
function fillTo(n: number, userId = ALICE) {
	const ids: string[] = [];
	for (let i = 0; i < n; i++) {
		ids.push(remember(`memory ${i}`, userId, new Date(1_000_000 + i * 1000)));
	}
	return ids;
}

const active = (userId = ALICE) =>
	db
		.select()
		.from(memoryItems)
		.where(and(eq(memoryItems.userId, userId), eq(memoryItems.status, 'active')))
		.all();

const promptOf = () => String(requests.at(-1)?.messages.at(-1)?.content ?? '');

describe('the working set', () => {
	it('sends the cap, not everything ever recorded', async () => {
		activity();
		fillTo(25);
		reply = '{}';
		await runMemory('manual', ALICE);

		const prompt = promptOf();
		// Twenty numbered, and the rest accounted for rather than pasted in.
		expect(prompt).toContain('[20]');
		expect(prompt).not.toContain('[21]');
		expect(prompt).toContain('5 older memories are stored but never reach a prompt');
	});

	it('refuses a new memory when the set is full and nothing is named', async () => {
		activity();
		fillTo(20);
		reply = JSON.stringify({ add: [{ kind: 'fact', content: 'something new' }] });
		const res = await runMemory('manual', ALICE);

		expect(res.memories).toBe(0);
		expect(active()).toHaveLength(20);
		expect(active().map((m) => m.content)).not.toContain('something new');
	});

	it('lets a new memory in when it says what it displaces', async () => {
		activity();
		fillTo(20);
		reply = JSON.stringify({
			add: [{ kind: 'fact', content: 'something better', replaces: 20, preserve: false }]
		});
		const res = await runMemory('manual', ALICE);

		expect(res.memories).toBe(1);
		expect(res.displaced).toBe(1);
		const contents = active().map((m) => m.content);
		expect(contents).toHaveLength(20);
		expect(contents).toContain('something better');
		// [20] is the oldest of the twenty, since the list is newest-first.
		expect(contents).not.toContain('memory 0');
	});

	it('adds freely while there is room', async () => {
		activity();
		fillTo(2);
		reply = JSON.stringify({ add: [{ kind: 'preference', content: 'wants minimal diffs' }] });
		const res = await runMemory('manual', ALICE);

		expect(res.memories).toBe(1);
		expect(res.displaced).toBe(0);
		expect(active()).toHaveLength(3);
	});

	it('will not let one run replace the whole set', async () => {
		activity();
		fillTo(20);
		reply = JSON.stringify({
			add: Array.from({ length: 10 }, (_, i) => ({
				kind: 'fact',
				content: `replacement ${i}`,
				replaces: i + 1
			}))
		});
		const res = await runMemory('manual', ALICE);

		// Three in, three out — a bad audit costs a corner of the set, not all of it.
		expect(res.displaced).toBe(3);
		expect(res.memories).toBe(3);
		expect(active()).toHaveLength(20);
	});

	it('lets a retirement pay for an addition in the same run', async () => {
		// The slot count was read before the retirements were applied, so a run
		// that retired something and then added something had the addition
		// refused for want of the slot it had just made itself.
		activity();
		fillTo(20);
		reply = JSON.stringify({
			retire: [{ item: 1, preserve: false, why: 'no longer true' }],
			add: [{ kind: 'fact', content: 'took the freed slot' }]
		});
		const res = await runMemory('manual', ALICE);

		expect(res.displaced).toBe(1);
		expect(res.memories).toBe(1);
		expect(active().map((m) => m.content)).toContain('took the freed slot');
		expect(active()).toHaveLength(20);
	});

	it('makes retiring drain the surplus while the set is over its ceiling', async () => {
		// Over the cap, a retirement has to shrink the list rather than fund a
		// replacement for it — otherwise a set being tidied by hand never gets
		// any smaller.
		activity();
		fillTo(23);
		reply = JSON.stringify({
			retire: [{ item: 1, preserve: false }],
			add: [{ kind: 'fact', content: 'not yet' }]
		});
		const res = await runMemory('manual', ALICE);

		expect(res.displaced).toBe(1);
		expect(res.memories).toBe(0);
		expect(active()).toHaveLength(22);
		expect(active().map((m) => m.content)).not.toContain('not yet');
	});

	it('still lets a displacement through while over the ceiling', async () => {
		// One for one changes nothing about the total, so it is the one move
		// that stays open — the set can keep improving while it drains.
		activity();
		fillTo(23);
		reply = JSON.stringify({
			add: [{ kind: 'fact', content: 'a better one', replaces: 1, preserve: false }]
		});
		const res = await runMemory('manual', ALICE);

		expect(res.memories).toBe(1);
		expect(active()).toHaveLength(23);
		expect(active().map((m) => m.content)).toContain('a better one');
	});

	it('ignores a number that names nothing', async () => {
		activity();
		fillTo(3);
		reply = JSON.stringify({ retire: [{ item: 99 }, { item: 0 }, { item: 'two' }] });
		await runMemory('manual', ALICE);
		expect(active()).toHaveLength(3);
	});

	it('deletes what leaves rather than archiving it', async () => {
		// Archived is the person's own "never record this again", handed back to
		// this prompt as exactly that. Something that merely lost a round must
		// not be suppressed for good.
		activity();
		fillTo(3);
		reply = JSON.stringify({ retire: [{ item: 1, preserve: false, why: 'no longer true' }] });
		await runMemory('manual', ALICE);

		const rows = db.select().from(memoryItems).where(eq(memoryItems.userId, ALICE)).all();
		expect(rows).toHaveLength(2);
		expect(rows.every((r) => r.status === 'active')).toBe(true);
	});
});

describe('the long-term record', () => {
	it('files what the audit said was worth keeping', async () => {
		activity();
		fillTo(3);
		reply = JSON.stringify({
			retire: [{ item: 1, preserve: true, why: 'superseded by a sharper note' }]
		});
		await runMemory('manual', ALICE);

		const doc = findDocByTitle('Long term user memory', ALICE)!;
		expect(doc).toBeTruthy();
		const body = getDoc(doc.id, ALICE)!.body;
		expect(body).toContain('memory 2');
		expect(body).toContain('superseded by a sharper note');
	});

	it('drops what it said was not', async () => {
		activity();
		fillTo(3);
		reply = JSON.stringify({ retire: [{ item: 1, preserve: false }] });
		await runMemory('manual', ALICE);

		expect(findDocByTitle('Long term user memory', ALICE)).toBeNull();
		expect(active()).toHaveLength(2);
	});

	it('keeps the newest entries at the top, where a truncated read finds them', async () => {
		activity();
		fillTo(3);
		reply = JSON.stringify({ retire: [{ item: 1, preserve: true, why: 'first out' }] });
		await runMemory('manual', ALICE);

		activity();
		reply = JSON.stringify({ retire: [{ item: 1, preserve: true, why: 'second out' }] });
		await runMemory('manual', ALICE);

		const doc = findDocByTitle('Long term user memory', ALICE)!;
		const body = getDoc(doc.id, ALICE)!.body;
		expect(body.indexOf('second out')).toBeLessThan(body.indexOf('first out'));
	});

	it('belongs to its owner and nobody else', async () => {
		activity();
		fillTo(3);
		reply = JSON.stringify({ retire: [{ item: 1, preserve: true, why: 'private detail' }] });
		await runMemory('manual', ALICE);

		const doc = findDocByTitle('Long term user memory', ALICE)!;
		expect(doc.ownerId).toBe(ALICE);
		// The Library is the one store whose contents reach another person's
		// prompt, and this is the document that must never do it.
		expect(doc.visibility).toBe('personal');
		expect(findDocByTitle('Long term user memory', BOB)).toBeNull();
		expect(getDoc(doc.id, BOB)).toBeNull();
	});
});

describe('dismissals', () => {
	it('shows the recent ones and counts the rest', async () => {
		activity();
		for (let i = 0; i < 60; i++) {
			const id = remember(`dismissed ${i}`, ALICE, new Date(2_000_000 + i * 1000));
			db.update(memoryItems).set({ status: 'archived' }).where(eq(memoryItems.id, id)).run();
		}
		await runMemory('manual', ALICE);

		const prompt = promptOf();
		expect(prompt).toContain('dismissed 59');
		expect(prompt).not.toContain('dismissed 0\n');
		expect(prompt).toContain('10 older dismissals not listed');
	});
});

describe('when the model does not answer', () => {
	it('says which limit it hit and leaves the watermark where it was', async () => {
		activity();
		const before = await import('./memory').then((m) => m.getMemoryStatus(ALICE).watermark);
		thrown = Object.assign(new Error('The operation was aborted due to timeout'), {
			name: 'TimeoutError'
		});
		const res = await runMemory('manual', ALICE);

		expect(res.ran).toBe(false);
		expect(res.reason).toMatch(/did not answer within the 180s/);
		expect(res.reason).toContain('Admin → Memory');
		// Held back, so the next run re-reads the same window instead of losing it.
		const after = await import('./memory').then((m) => m.getMemoryStatus(ALICE).watermark);
		expect(after).toBe(before);
	});
});

describe('memoryDigest', () => {
	it('is the whole set now that the set is the size of the digest', async () => {
		fillTo(5);
		const digest = memoryDigest(ALICE);
		for (let i = 0; i < 5; i++) expect(digest).toContain(`memory ${i}`);
	});
});
