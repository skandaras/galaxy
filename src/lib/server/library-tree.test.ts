import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, runMigrations } from '$lib/server/db';
import { libraryDocs } from '$lib/server/db/schema';
import {
	canPlace,
	deleteDoc,
	docPath,
	getDoc,
	libraryDigest,
	LibraryTreeError,
	listChildren,
	MAX_DEPTH,
	moveDoc,
	saveDoc,
	subtreeCounts
} from './library';

const ALICE = 'user-alice';
const BOB = 'user-bob';

beforeAll(() => {
	runMigrations();
});

beforeEach(() => {
	db.delete(libraryDocs).run();
	db.run(sql`DELETE FROM library_fts`);
});

const write = (title: string, opts: { parentId?: string; folder?: string; owner?: string } = {}) =>
	saveDoc({
		title,
		body: 'contents',
		author: 'user',
		ownerId: opts.owner ?? ALICE,
		...(opts.parentId ? { parentId: opts.parentId } : {}),
		...(opts.folder ? { folder: opts.folder } : {})
	});

/** A chain root → child → grandchild → …, returning every id top down. */
function chain(depth: number): string[] {
	const ids: string[] = [];
	let parent: string | undefined;
	for (let i = 0; i < depth; i++) {
		const doc = write(`Level ${i + 1}`, parent ? { parentId: parent } : {});
		ids.push(doc.id);
		parent = doc.id;
	}
	return ids;
}

describe('placing a doc', () => {
	it('makes a root its own tree', () => {
		const root = write('Epic');
		expect(root.parentId).toBeNull();
		// Never null, because the digest groups on it — a null would put every
		// pre-tree doc in one bucket.
		expect(root.rootId).toBe(root.id);
	});

	it('puts a child in its parent’s tree', () => {
		const root = write('Epic');
		const child = write('Sprint 1', { parentId: root.id });
		expect(child.parentId).toBe(root.id);
		expect(child.rootId).toBe(root.id);
		expect(write('Task 1', { parentId: child.id }).rootId).toBe(root.id);
	});

	it('refuses to make a doc its own ancestor', () => {
		const [root, child, grandchild] = chain(3);
		expect(canPlace(root, root)).toEqual({ ok: false, reason: 'cycle' });
		expect(canPlace(root, child)).toEqual({ ok: false, reason: 'cycle' });
		// Two hops up, which is the one a single self-check would miss.
		expect(canPlace(root, grandchild)).toEqual({ ok: false, reason: 'cycle' });
		expect(moveDoc(root, ALICE, grandchild)).toEqual({ ok: false, reason: 'cycle' });
	});

	it('refuses to nest past the depth cap', () => {
		const ids = chain(MAX_DEPTH);
		expect(canPlace(null, ids[MAX_DEPTH - 2]).ok).toBe(true);
		expect(canPlace(null, ids[MAX_DEPTH - 1])).toEqual({ ok: false, reason: 'depth' });
		expect(() => write('One too far', { parentId: ids[MAX_DEPTH - 1] })).toThrow(LibraryTreeError);
	});

	it('refuses a parent that does not exist', () => {
		expect(canPlace(null, 'no-such-doc')).toEqual({ ok: false, reason: 'no-parent' });
	});

	it('will not file a doc under one the person cannot see', () => {
		const hidden = saveDoc({
			title: 'Bobs private',
			body: 'x',
			author: 'user',
			ownerId: BOB,
			visibility: 'personal'
		});
		const mine = write('Mine');
		expect(moveDoc(mine.id, ALICE, hidden.id)).toEqual({ ok: false, reason: 'no-parent' });
	});
});

describe('moving a subtree', () => {
	it('carries its descendants into the new tree', () => {
		const [root, child, grandchild] = chain(3);
		const other = write('Another epic');

		expect(moveDoc(child, ALICE, other.id).ok).toBe(true);
		// The whole point: a move that only repointed the moved row would leave
		// the grandchild claiming a tree it is no longer in, and the digest counts
		// that column.
		expect(getDoc(grandchild, ALICE)?.meta.rootId).toBe(other.id);
		expect(getDoc(root, ALICE)?.meta.rootId).toBe(root);
	});

	it('makes a doc a root again when moved to the top', () => {
		const [, child, grandchild] = chain(3);
		expect(moveDoc(child, ALICE, null).ok).toBe(true);
		expect(getDoc(child, ALICE)?.meta.parentId).toBeNull();
		expect(getDoc(child, ALICE)?.meta.rootId).toBe(child);
		expect(getDoc(grandchild, ALICE)?.meta.rootId).toBe(child);
	});

	it('moves through saveDoc too, descendants included', () => {
		const [root, child, grandchild] = chain(3);
		const other = write('Another epic');
		saveDoc({
			id: child,
			title: 'Level 2',
			body: 'contents',
			author: 'user',
			ownerId: ALICE,
			parentId: other.id
		});
		expect(getDoc(grandchild, ALICE)?.meta.rootId).toBe(other.id);
		expect(getDoc(root, ALICE)?.meta.rootId).toBe(root);
	});

	it('leaves a doc where it is when the parent is not mentioned', () => {
		const [root, child] = chain(2);
		saveDoc({ id: child, title: 'Level 2', body: 'edited', author: 'user', ownerId: ALICE });
		// A save from somewhere with no notion of the tree — the memory job, a
		// plain edit — must not lift a doc out of it.
		expect(getDoc(child, ALICE)?.meta.parentId).toBe(root);
	});

	it('refuses to move someone else’s doc', () => {
		const theirs = saveDoc({ title: 'Theirs', body: 'x', author: 'user', ownerId: BOB });
		const mine = write('Mine');
		expect(moveDoc(theirs.id, ALICE, mine.id)).toEqual({ ok: false, reason: 'forbidden' });
	});
});

describe('deleting', () => {
	it('promotes children rather than orphaning or cascading them', () => {
		const [root, child, grandchild] = chain(3);
		expect(deleteDoc(child, ALICE)).toBe(true);
		// Promotion is the only one of refuse / cascade / promote that cannot lose
		// a document, which is what makes nesting safe to offer at all.
		expect(getDoc(grandchild, ALICE)).not.toBeNull();
		expect(getDoc(grandchild, ALICE)?.meta.parentId).toBe(root);
		expect(getDoc(grandchild, ALICE)?.meta.rootId).toBe(root);
	});

	it('makes the children of a deleted root into roots', () => {
		const [root, child, grandchild] = chain(3);
		expect(deleteDoc(root, ALICE)).toBe(true);
		expect(getDoc(child, ALICE)?.meta.parentId).toBeNull();
		expect(getDoc(child, ALICE)?.meta.rootId).toBe(child);
		expect(getDoc(grandchild, ALICE)?.meta.rootId).toBe(child);
	});
});

describe('reading the tree', () => {
	it('lists direct children, and roots when asked for nothing', () => {
		const root = write('Epic');
		write('Sprint 1', { parentId: root.id });
		write('Sprint 2', { parentId: root.id });
		const loose = write('Unrelated');

		expect(listChildren(root.id, ALICE).map((d) => d.title).sort()).toEqual(['Sprint 1', 'Sprint 2']);
		expect(listChildren(null, ALICE).map((d) => d.id).sort()).toEqual([loose.id, root.id].sort());
	});

	it('walks the path from the root down', () => {
		const [, , grandchild] = chain(3);
		expect(docPath(grandchild, ALICE)).toEqual(['Level 1', 'Level 2', 'Level 3']);
	});

	it('stops a path at an ancestor the reader cannot see', () => {
		const theirs = saveDoc({
			title: 'Bobs epic',
			body: 'x',
			author: 'user',
			ownerId: BOB,
			visibility: 'personal'
		});
		const shared = saveDoc({
			title: 'Shared child',
			body: 'x',
			author: 'user',
			ownerId: BOB,
			visibility: 'shared',
			parentId: theirs.id
		});
		// A breadcrumb must not name a title out of somebody else's shelf.
		expect(docPath(shared.id, ALICE)).toEqual(['Shared child']);
		expect(docPath(shared.id, BOB)).toEqual(['Bobs epic', 'Shared child']);
	});

	it('counts a whole subtree against its root', () => {
		const [root] = chain(3);
		write('Sibling', { parentId: root });
		expect(subtreeCounts(ALICE).get(root)).toBe(4);
	});
});

describe('the digest', () => {
	it('spends one line on a subtree however big it is', () => {
		const root = write('Galaxy mobile');
		const sprint = write('Sprint 1', { parentId: root.id });
		for (let i = 0; i < 200; i++) write(`Task ${i}`, { parentId: sprint.id });

		const digest = libraryDigest(ALICE);
		const lines = digest.split('\n').filter((l) => l.startsWith('- '));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain('Galaxy mobile');
		expect(lines[0]).toContain('201 documents beneath it');
		// The thing the whole change is for: no leaf reaches the block that every
		// chat and coding turn in the app pays for.
		expect(digest).not.toContain('Task 7');
	});

	it('names a small tree’s children rather than counting them', () => {
		const root = write('Small epic');
		write('Sprint 1', { parentId: root.id });
		write('Sprint 2', { parentId: root.id });
		const digest = libraryDigest(ALICE);
		expect(digest).toContain('Sprint 1');
		expect(digest).toContain('Sprint 2');
		expect(digest).not.toContain('documents beneath it');
	});

	it('still groups loose docs by folder, as a shelf with no trees always did', () => {
		write('Roast potatoes', { folder: 'Recipes' });
		write('Bread', { folder: 'Recipes' });
		write('Odd note');
		const lines = libraryDigest(ALICE)
			.split('\n')
			.filter((l) => l.startsWith('- '));
		// Every doc is its own root after the backfill, so grouping by root alone
		// would turn a three-document shelf into three lines instead of two.
		expect(lines).toHaveLength(2);
		expect(lines.find((l) => l.startsWith('- Recipes'))).toContain('Bread');
		expect(lines.find((l) => l.startsWith('- Unfiled'))).toContain('Odd note');
	});

	it('windows on roots, not documents', () => {
		const root = write('One big tree');
		for (let i = 0; i < 60; i++) write(`Child ${i}`, { parentId: root.id });
		// Sixty-one documents, one root: the old window would have been full.
		expect(libraryDigest(ALICE, 40)).not.toContain('…and');

		for (let i = 0; i < 60; i++) write(`Loose ${i}`);
		expect(libraryDigest(ALICE, 40)).toContain('…and');
	});

	it('keeps another person’s tree out of it entirely', () => {
		const theirs = saveDoc({
			title: 'Bobs epic',
			body: 'x',
			author: 'user',
			ownerId: BOB,
			visibility: 'personal'
		});
		saveDoc({
			title: 'Bobs sprint',
			body: 'x',
			author: 'user',
			ownerId: BOB,
			visibility: 'personal',
			parentId: theirs.id
		});
		const digest = libraryDigest(ALICE);
		expect(digest).not.toContain('Bobs epic');
		expect(digest).not.toContain('Bobs sprint');
	});

	it('reads a doc written before the column existed as its own root', () => {
		const doc = write('Legacy');
		// What a rollback to the previous image and back again leaves behind: the
		// backfill has already run, so nothing repairs these on the way forward.
		db.run(sql`UPDATE library_docs SET root_id = NULL WHERE id = ${doc.id}`);
		expect(subtreeCounts(ALICE).get(doc.id)).toBe(1);
		expect(libraryDigest(ALICE)).toContain('Legacy');
	});
});
