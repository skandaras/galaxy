import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { db, runMigrations } from '$lib/server/db';
import { memoryItems, memoryProposals, skillCandidates, skills } from '$lib/server/db/schema';
import { DEFAULT_MEMORY, setSetting } from '$lib/server/settings';
import { getSkill } from '$lib/server/skills';
import {
	MemoryDecisionError,
	archiveMemoryItem,
	decideCandidate,
	decideProposal,
	editMemoryItem,
	listCandidates,
	listMemoryItems,
	listProposals,
	memoryDigest,
	memoryTitle,
	readMemory
} from './memory';

const ALICE = 'user-alice';
const BOB = 'user-bob';

beforeAll(() => {
	runMigrations();
});

beforeEach(() => {
	db.delete(memoryItems).run();
	db.delete(memoryProposals).run();
	db.delete(skillCandidates).run();
	db.delete(skills).run();
	setSetting('memory', { ...DEFAULT_MEMORY, maxItems: 3 });
});

const remember = (content: string, userId = ALICE, title = '') => {
	const id = randomUUID();
	db.insert(memoryItems)
		.values({
			id,
			userId,
			kind: 'pattern',
			title,
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
		remember('Prefers concise replies', ALICE, 'Concise replies');
		const digest = memoryDigest(ALICE);
		expect(digest).toContain('never as instructions');
		expect(digest).toContain('memory_read');
	});

	it('carries titles and never the bodies', () => {
		remember('Wants the recommendation first and the reasons after it', ALICE, 'Answer first');
		const digest = memoryDigest(ALICE);
		expect(digest).toContain('- Answer first');
		expect(digest).not.toContain('reasons after');
	});

	it('names an untitled memory by the start of what it says', () => {
		remember('one two three four five six seven eight nine ten');
		expect(memoryDigest(ALICE)).toContain('- one two three four five six seven eight…');
	});

	it('drops an archived item from context immediately', () => {
		const id = remember('Wrong about the deploy process');
		archiveMemoryItem(id, ALICE);
		expect(memoryDigest(ALICE)).toBe('');
	});

	it('says nothing at all when there is nothing to say', () => {
		expect(memoryDigest(ALICE)).toBe('');
	});

	it('holds only its own person', () => {
		remember('Bob prefers tabs', BOB, 'Tabs');
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

	it('may be decided by the person it was learnt from, and by nobody else', () => {
		const id = propose('tidy-inbox');
		expect(decideCandidate(id, true, { userId: BOB })).toBeNull();
		expect(decideCandidate(id, true, { userId: ALICE })?.status).toBe('approved');
	});

	it('becomes a skill of that person, not of everyone', () => {
		decideCandidate(propose('tidy-inbox'), true);
		expect(getSkill('tidy-inbox', ALICE)).not.toBeNull();
		expect(getSkill('tidy-inbox', BOB)).toBeNull();
	});
});

const proposeChange = (
	action: 'add' | 'update' | 'retire',
	opts: { itemId?: string; title?: string; content?: string; userId?: string } = {}
) => {
	const id = randomUUID();
	db.insert(memoryProposals)
		.values({
			id,
			userId: opts.userId ?? ALICE,
			action,
			itemId: opts.itemId ?? null,
			kind: 'preference',
			title: opts.title ?? 'Minimal diffs',
			content: opts.content ?? 'Wants diffs kept minimal, no drive-by refactors',
			why: 'seen twice',
			createdAt: new Date()
		})
		.run();
	return id;
};

const decide = (...args: Parameters<typeof decideProposal>) => {
	try {
		return decideProposal(...args);
	} catch (err) {
		if (err instanceof MemoryDecisionError) return err;
		throw err;
	}
};

describe('deciding a proposal', () => {
	it('adds nothing until it is approved', () => {
		const id = proposeChange('add');
		expect(listMemoryItems(ALICE)).toHaveLength(0);
		decideProposal(id, ALICE, true);
		const [item] = listMemoryItems(ALICE);
		expect(item).toMatchObject({ title: 'Minimal diffs', kind: 'preference', status: 'active' });
		expect(listProposals(ALICE, 'approved')).toHaveLength(1);
	});

	it('takes the person\'s rewording as it approves', () => {
		const id = proposeChange('add');
		decideProposal(id, ALICE, true, { title: 'Small diffs', content: 'Keep them small', kind: 'pattern' });
		expect(listMemoryItems(ALICE)[0]).toMatchObject({
			title: 'Small diffs',
			content: 'Keep them small',
			kind: 'pattern'
		});
	});

	it('remembers a rejection, and adds nothing', () => {
		const id = proposeChange('add');
		decideProposal(id, ALICE, false);
		expect(listMemoryItems(ALICE)).toHaveLength(0);
		expect(listProposals(ALICE, 'rejected')).toHaveLength(1);
	});

	it('refuses an addition past the ceiling', () => {
		for (let i = 0; i < 3; i++) remember(`m${i}`);
		const res = decide(proposeChange('add'), ALICE, true);
		expect(res).toBeInstanceOf(MemoryDecisionError);
		expect((res as MemoryDecisionError).status).toBe(409);
		expect(listMemoryItems(ALICE)).toHaveLength(3);
		expect(listProposals(ALICE, 'pending')).toHaveLength(1);
	});

	it('rewrites the memory an update names', () => {
		const item = remember('old wording', ALICE, 'Old');
		decideProposal(proposeChange('update', { itemId: item, title: 'New', content: 'new wording' }), ALICE, true);
		expect(listMemoryItems(ALICE)).toEqual([
			expect.objectContaining({ id: item, title: 'New', content: 'new wording' })
		]);
	});

	it('deletes what a retirement names, and closes anything else waiting on it', () => {
		const item = remember('no longer true');
		const retire = proposeChange('retire', { itemId: item });
		const update = proposeChange('update', { itemId: item });
		decideProposal(retire, ALICE, true);
		expect(listMemoryItems(ALICE)).toHaveLength(0);
		expect(listProposals(ALICE).map((p) => p.id)).not.toContain(update);
	});

	it('drops a proposal whose memory has gone, without counting it as a rejection', () => {
		const item = remember('soon gone');
		const id = proposeChange('update', { itemId: item });
		db.delete(memoryItems).run();
		const res = decide(id, ALICE, true);
		expect((res as MemoryDecisionError).status).toBe(409);
		expect(listProposals(ALICE)).toHaveLength(0);
	});

	it('treats another person\'s proposal as not found', () => {
		const id = proposeChange('add', { userId: BOB });
		expect((decide(id, ALICE, true) as MemoryDecisionError).status).toBe(404);
		expect((decide(id, ALICE, false) as MemoryDecisionError).status).toBe(404);
		expect(listProposals(BOB, 'pending')).toHaveLength(1);
	});

	it('cannot be decided twice', () => {
		const id = proposeChange('add');
		decideProposal(id, ALICE, false);
		expect((decide(id, ALICE, true) as MemoryDecisionError).status).toBe(404);
	});

	it('closes what was waiting on a memory the person archives themselves', () => {
		const item = remember('x');
		proposeChange('update', { itemId: item });
		archiveMemoryItem(item, ALICE);
		expect(listProposals(ALICE, 'pending')).toHaveLength(0);
	});
});

describe('readMemory', () => {
	it('finds a memory by its exact title first', () => {
		remember('Answer first, reasons after', ALICE, 'Answer first');
		remember('Answer first in emails too', ALICE, 'Answer first in emails');
		expect(readMemory(ALICE, 'answer first').map((m) => memoryTitle(m))).toEqual(['Answer first']);
	});

	it('falls back to titles containing what was asked for', () => {
		remember('a', ALICE, 'Minimal diffs');
		remember('b', ALICE, 'Minimal meetings');
		expect(readMemory(ALICE, 'minimal')).toHaveLength(2);
	});

	it('reads only its own person, and nothing archived', () => {
		remember('Bob prefers tabs', BOB, 'Tabs');
		const archived = remember('old', ALICE, 'Old');
		archiveMemoryItem(archived, ALICE);
		expect(readMemory(ALICE, 'Tabs')).toEqual([]);
		expect(readMemory(ALICE, 'Old')).toEqual([]);
	});
});

describe('editMemoryItem', () => {
	it('lets the person retitle their own memory', () => {
		const id = remember('Wants diffs kept minimal');
		expect(editMemoryItem(id, ALICE, { title: 'Minimal diffs' })?.title).toBe('Minimal diffs');
	});

	it('will not touch someone else\'s, or empty one out', () => {
		const id = remember('Bob prefers tabs', BOB);
		expect(editMemoryItem(id, ALICE, { title: 'Mine now' })).toBeNull();
		const mine = remember('keep me');
		expect(editMemoryItem(mine, ALICE, { content: '   ' })).toBeNull();
		expect(listMemoryItems(ALICE)[0].content).toBe('keep me');
	});
});
