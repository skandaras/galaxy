import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, runMigrations } from '$lib/server/db';
import { libraryDocs } from '$lib/server/db/schema';
import {
	canEdit,
	deleteDoc,
	findDocByTitle,
	getDoc,
	libraryDigest,
	listDocs,
	saveDoc,
	searchDocs,
	setVisibility
} from './library';

const ALICE = 'user-alice';
const BOB = 'user-bob';

beforeAll(() => {
	runMigrations();
});

beforeEach(() => {
	db.delete(libraryDocs).run();
	// FTS5 sits outside drizzle's schema management, so it is cleared directly.
	db.run(sql`DELETE FROM library_fts`);
});

const write = (
	owner: string,
	title: string,
	visibility: 'personal' | 'shared',
	body = 'contents'
) => saveDoc({ title, body, author: 'user', ownerId: owner, visibility });

describe('visibility', () => {
	it('keeps a personal doc to its owner', () => {
		write(ALICE, 'Alice private', 'personal');

		expect(listDocs(ALICE).map((d) => d.title)).toEqual(['Alice private']);
		expect(listDocs(BOB)).toHaveLength(0);
	});

	it('shows a shared doc to everyone', () => {
		write(ALICE, 'Team notes', 'shared');

		expect(listDocs(ALICE).map((d) => d.title)).toEqual(['Team notes']);
		expect(listDocs(BOB).map((d) => d.title)).toEqual(['Team notes']);
	});

	it('treats an unowned doc as everyone’s', () => {
		// The library had no owner column at all before this, so every existing
		// doc arrives as NULL and must keep behaving exactly as it did.
		db.insert(libraryDocs)
			.values({
				id: 'legacy',
				title: 'Legacy doc',
				snippet: '',
				author: 'user',
				ownerId: null,
				visibility: 'shared',
				sizeBytes: 0,
				createdAt: new Date(),
				updatedAt: new Date()
			})
			.run();

		expect(listDocs(ALICE).map((d) => d.id)).toContain('legacy');
		expect(listDocs(BOB).map((d) => d.id)).toContain('legacy');
	});

	it('defaults a new doc to personal', () => {
		const doc = saveDoc({ title: 'Fresh', body: 'x', author: 'user', ownerId: ALICE });
		expect(doc.visibility).toBe('personal');
		expect(listDocs(BOB)).toHaveLength(0);
	});
});

describe('reads other than list', () => {
	it('hides another user’s personal doc from getDoc', () => {
		const doc = write(ALICE, 'Alice private', 'personal');
		expect(getDoc(doc.id, ALICE)).not.toBeNull();
		// Indistinguishable from a doc that does not exist.
		expect(getDoc(doc.id, BOB)).toBeNull();
	});

	it('hides it from title lookup', () => {
		write(ALICE, 'Alice private', 'personal');
		expect(findDocByTitle('Alice private', ALICE)).not.toBeNull();
		expect(findDocByTitle('Alice private', BOB)).toBeNull();
	});

	it('hides it from search, even on a matching term', () => {
		write(ALICE, 'Alice private', 'personal', 'pineapple marker');
		write(ALICE, 'Shared thing', 'shared', 'pineapple marker');

		expect(searchDocs('pineapple', ALICE).map((d) => d.title).sort()).toEqual([
			'Alice private',
			'Shared thing'
		]);
		expect(searchDocs('pineapple', BOB).map((d) => d.title)).toEqual(['Shared thing']);
	});

	it('keeps it out of the other user’s agent context', () => {
		// The digest goes straight into a system prompt, so this is the assertion
		// that actually stops one person's notes reaching another's model.
		write(ALICE, 'Alice private', 'personal');
		write(ALICE, 'Team notes', 'shared');

		expect(libraryDigest(ALICE)).toContain('Alice private');
		expect(libraryDigest(BOB)).not.toContain('Alice private');
		expect(libraryDigest(BOB)).toContain('Team notes');
	});
});

describe('writes', () => {
	it('lets the owner change visibility', () => {
		const doc = write(ALICE, 'Notes', 'personal');
		expect(setVisibility(doc.id, ALICE, 'shared')?.visibility).toBe('shared');
		expect(listDocs(BOB)).toHaveLength(1);
	});

	it('refuses to let a non-owner change or delete a shared doc', () => {
		const doc = write(ALICE, 'Team notes', 'shared');

		expect(setVisibility(doc.id, BOB, 'personal')).toBeNull();
		expect(deleteDoc(doc.id, BOB)).toBe(false);
		// Still there, still shared.
		expect(listDocs(BOB)).toHaveLength(1);
	});

	it('lets the owner delete their own', () => {
		const doc = write(ALICE, 'Notes', 'personal');
		expect(deleteDoc(doc.id, ALICE)).toBe(true);
		expect(listDocs(ALICE)).toHaveLength(0);
	});

	it('claims an unowned doc for whoever first changes it', () => {
		db.insert(libraryDocs)
			.values({
				id: 'legacy',
				title: 'Legacy',
				snippet: '',
				author: 'user',
				ownerId: null,
				visibility: 'shared',
				sizeBytes: 0,
				createdAt: new Date(),
				updatedAt: new Date()
			})
			.run();

		const updated = setVisibility('legacy', ALICE, 'personal');
		expect(updated?.ownerId).toBe(ALICE);
		expect(listDocs(BOB)).toHaveLength(0);
	});

	it('keeps the original owner when an existing doc is edited', () => {
		const doc = write(ALICE, 'Notes', 'shared');
		// Bob can read it; saveDoc must not transfer ownership to him.
		const again = saveDoc({
			id: doc.id,
			title: 'Notes',
			body: 'edited',
			author: 'user',
			ownerId: BOB
		});
		expect(again.ownerId).toBe(ALICE);
	});
});

describe('canEdit', () => {
	it('is true for the owner and for unowned docs', () => {
		expect(canEdit({ ownerId: ALICE }, ALICE)).toBe(true);
		expect(canEdit({ ownerId: null }, BOB)).toBe(true);
		expect(canEdit({ ownerId: ALICE }, BOB)).toBe(false);
	});
});
