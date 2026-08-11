import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { db, runMigrations } from '$lib/server/db';
import { memoryItems, skillCandidates } from '$lib/server/db/schema';
import { archiveMemoryItem, decideCandidate, listCandidates, memoryDigest } from './memory';

const ALICE = 'user-alice';

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
