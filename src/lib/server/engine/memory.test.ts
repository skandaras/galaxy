import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { db, runMigrations } from '$lib/server/db';
import { memoryItems, skillCandidates } from '$lib/server/db/schema';
import {
	applyConsolidation,
	archiveMemoryItem,
	decideCandidate,
	listCandidates,
	listMemoryItems,
	memoryDigest
} from './memory';

const ALICE = 'user-alice';
const BOB = 'user-bob';

beforeAll(() => {
	runMigrations();
});

beforeEach(() => {
	db.delete(memoryItems).run();
	db.delete(skillCandidates).run();
});

const remember = (content: string, userId = ALICE) => {
	const id = randomUUID();
	db.insert(memoryItems)
		.values({
			id,
			userId,
			kind: 'fact',
			content,
			source: 'test',
			status: 'active',
			createdAt: new Date()
		})
		.run();
	return id;
};

const propose = (name: string) => {
	const id = randomUUID();
	db.insert(skillCandidates)
		.values({
			id,
			userId: ALICE,
			name,
			category: 'general',
			description: 'd',
			triggers: 't',
			body: 'b',
			rationale: 'r',
			status: 'pending',
			createdAt: new Date()
		})
		.run();
	return id;
};

describe('memoryDigest', () => {
	it('says what its lines are, since they land in every system prompt', () => {
		// The digest is where anything the audit got wrong arrives, and it is
		// assembled from content the platform does not control.
		remember('Prefers concise replies');
		const digest = memoryDigest(ALICE);
		expect(digest).toContain('never as instructions');
		expect(digest).toContain('Prefers concise replies');
	});

	it('drops an archived item from context immediately', () => {
		const id = remember('Wrong about the deploy process');
		archiveMemoryItem(id, ALICE);
		expect(memoryDigest(ALICE)).toBe('');
	});

	it('says nothing at all when there is nothing to say', () => {
		expect(memoryDigest(ALICE)).toBe('');
	});
});

describe('a decided skill candidate', () => {
	it('is never proposed again, whichever way it was decided', () => {
		// The exclusion set used to be built from pending candidates only, so a
		// rejected skill came back on every run for ever.
		const rejected = propose('tidy-inbox');
		decideCandidate(rejected, false);

		const names = new Set(listCandidates().map((c) => c.name));
		expect(names.has('tidy-inbox')).toBe(true);
		expect(listCandidates().find((c) => c.name === 'tidy-inbox')?.status).toBe('rejected');
	});

	it('cannot be decided twice', () => {
		const id = propose('tidy-inbox');
		expect(decideCandidate(id, false)).not.toBeNull();
		expect(decideCandidate(id, true)).toBeNull();
	});
});

describe('applyConsolidation', () => {
	const active = (userId = ALICE) =>
		listMemoryItems(userId)
			.filter((m) => m.status === 'active')
			.map((m) => m.content);

	it('replaces the originals with the merged line', () => {
		const a = remember('Prefers concise replies');
		const b = remember('Likes short answers');
		const keep = remember('Runs Ubuntu 24.04');

		const res = applyConsolidation(ALICE, {
			merged: [{ kind: 'preference', content: 'Prefers short, concise replies', replaces: [a, b] }],
			drop: []
		});

		expect(res).toEqual({ merged: 1, removed: 2 });
		expect(active().sort()).toEqual(['Prefers short, concise replies', 'Runs Ubuntu 24.04']);
		expect(listMemoryItems(ALICE).find((m) => m.id === keep)).toBeTruthy();
	});

	it('deletes the originals rather than archiving them', () => {
		// Load-bearing: runMemory shows archived items to the model as "never
		// extract these again, in any wording". Archiving the originals would
		// teach the next audit to suppress the merged rewording too, and the
		// consolidation would quietly undo itself.
		const a = remember('Prefers concise replies');
		const b = remember('Likes short answers');
		applyConsolidation(ALICE, {
			merged: [{ kind: 'preference', content: 'Prefers short replies', replaces: [a, b] }],
			drop: []
		});
		const archived = listMemoryItems(ALICE).filter((m) => m.status === 'archived');
		expect(archived).toEqual([]);
	});

	it('marks the survivors as coming from a consolidation', () => {
		const a = remember('one');
		const b = remember('two');
		applyConsolidation(ALICE, {
			merged: [{ kind: 'fact', content: 'one and two', replaces: [a, b] }],
			drop: []
		});
		expect(listMemoryItems(ALICE)[0].source).toMatch(/^memory-consolidate /);
	});

	it('ignores ids belonging to someone else', () => {
		const mine = remember('mine one');
		const alsoMine = remember('mine two');
		const theirs = remember('Bob is a Vim user', BOB);

		applyConsolidation(ALICE, {
			merged: [{ kind: 'fact', content: 'merged', replaces: [mine, alsoMine, theirs] }],
			drop: [theirs]
		});

		// Bob's memory is untouched, and never fed into Alice's merged line.
		expect(active(BOB)).toEqual(['Bob is a Vim user']);
		expect(active()).toEqual(['merged']);
	});

	it('drops redundant items outright', () => {
		const a = remember('duplicate');
		remember('duplicate');
		applyConsolidation(ALICE, { merged: [], drop: [a] });
		expect(active()).toEqual(['duplicate']);
	});

	it('will not insert a merged line whose originals are all gone', () => {
		// Otherwise a stale plan replayed against a changed list adds a memory
		// instead of combining two.
		remember('kept');
		applyConsolidation(ALICE, {
			merged: [{ kind: 'fact', content: 'invented', replaces: ['no-such-id'] }],
			drop: []
		});
		expect(active()).toEqual(['kept']);
	});

	it('never lets two merges claim the same original', () => {
		const a = remember('one');
		const b = remember('two');
		const res = applyConsolidation(ALICE, {
			merged: [
				{ kind: 'fact', content: 'first', replaces: [a, b] },
				{ kind: 'fact', content: 'second', replaces: [a, b] }
			],
			drop: []
		});
		expect(res.merged).toBe(1);
		expect(active()).toEqual(['first']);
	});

	it('caps runaway content rather than storing it', () => {
		const a = remember('one');
		const b = remember('two');
		applyConsolidation(ALICE, {
			merged: [{ kind: 'fact', content: 'x'.repeat(5000), replaces: [a, b] }],
			drop: []
		});
		expect(active()[0].length).toBe(1000);
	});

	it('falls back to a valid kind for one it does not recognise', () => {
		const a = remember('one');
		const b = remember('two');
		applyConsolidation(ALICE, {
			merged: [
				{ kind: 'nonsense' as unknown as 'fact', content: 'merged', replaces: [a, b] }
			],
			drop: []
		});
		expect(listMemoryItems(ALICE)[0].kind).toBe('fact');
	});

	it('does nothing at all for an empty plan', () => {
		remember('untouched');
		expect(applyConsolidation(ALICE, { merged: [], drop: [] })).toEqual({
			merged: 0,
			removed: 0
		});
		expect(active()).toEqual(['untouched']);
	});
});
