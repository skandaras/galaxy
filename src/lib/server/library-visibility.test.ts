import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, runMigrations } from '$lib/server/db';
import { libraryDocs } from '$lib/server/db/schema';
import {
	canEdit,
	canManage,
	createFolder,
	deleteDoc,
	fileDoc,
	listFolders,
	LibraryTreeError,
	renameFolder,
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

describe('canEdit and canManage', () => {
	it('lets anyone edit a shared doc, and only the owner manage it', () => {
		expect(canEdit({ ownerId: ALICE, visibility: 'personal' }, ALICE)).toBe(true);
		expect(canEdit({ ownerId: null, visibility: 'personal' }, BOB)).toBe(true);
		expect(canEdit({ ownerId: ALICE, visibility: 'personal' }, BOB)).toBe(false);
		expect(canEdit({ ownerId: ALICE, visibility: 'shared' }, BOB)).toBe(true);
		expect(canManage({ ownerId: ALICE }, BOB)).toBe(false);
		expect(canManage({ ownerId: null }, BOB)).toBe(true);
	});
});

describe('a shared doc, for everyone who is not its owner', () => {
	it('can be edited, and stays its owner’s', () => {
		const doc = write(ALICE, 'Plan', 'shared');
		const edited = saveDoc({ id: doc.id, title: 'Plan', body: 'Bob was here', author: 'user', ownerId: BOB });
		expect(edited.ownerId).toBe(ALICE);
		expect(getDoc(doc.id, ALICE)?.body).toBe('Bob was here');
	});

	it('cannot be deleted or made personal', () => {
		const doc = write(ALICE, 'Plan', 'shared');
		expect(deleteDoc(doc.id, BOB)).toBe(false);
		expect(setVisibility(doc.id, BOB, 'personal')).toBeNull();
	});

	it('can be moved into a folder, which then shows on every shelf with only that doc in it', () => {
		const doc = write(ALICE, 'Plan', 'shared');
		write(BOB, 'Bob notes', 'personal');
		expect(createFolder(BOB, 'Ideas').ok).toBe(true);
		fileDoc(listDocs(BOB).find((d) => d.title === 'Bob notes')!.id, BOB, { folder: 'Ideas' });
		expect(fileDoc(doc.id, BOB, { folder: 'Ideas' }).ok).toBe(true);
		expect(listFolders(ALICE)).toContain('Ideas');
		expect(listDocs(ALICE).filter((d) => d.folder === 'Ideas').map((d) => d.title)).toEqual(['Plan']);
	});

	it('cannot go inside a doc that is not shared, by a move or by a save', () => {
		const doc = write(ALICE, 'Plan', 'shared');
		const mine = write(BOB, 'Bob notes', 'personal');
		expect(fileDoc(doc.id, BOB, { parentId: mine.id })).toEqual({ ok: false, reason: 'personal-parent' });
		expect(() =>
			saveDoc({ id: doc.id, title: 'Plan', body: 'x', author: 'user', ownerId: BOB, parentId: mine.id })
		).toThrow(LibraryTreeError);
		const theirs = write(ALICE, 'Shared parent', 'shared');
		expect(fileDoc(doc.id, BOB, { parentId: theirs.id }).ok).toBe(true);
	});

	it('leaves a personal doc free to go under a shared one', () => {
		const parent = write(ALICE, 'Shared parent', 'shared');
		const mine = write(BOB, 'Bob notes', 'personal');
		expect(fileDoc(mine.id, BOB, { parentId: parent.id }).ok).toBe(true);
	});

	it('moves with a folder rename, so the folder does not split', () => {
		const doc = write(ALICE, 'Plan', 'shared');
		fileDoc(doc.id, BOB, { folder: 'Ideas' });
		expect(renameFolder(BOB, 'Ideas', 'Thoughts').ok).toBe(true);
		expect(getDoc(doc.id, ALICE)?.meta.folder).toBe('Thoughts');
	});

	it('leaves someone else’s personal doc where it is on a rename', () => {
		const theirs = write(ALICE, 'Alice private', 'personal');
		fileDoc(theirs.id, ALICE, { folder: 'Ideas' });
		const shared = write(BOB, 'Bob shared', 'shared');
		fileDoc(shared.id, BOB, { folder: 'Ideas' });
		renameFolder(BOB, 'Ideas', 'Thoughts');
		expect(getDoc(theirs.id, ALICE)?.meta.folder).toBe('Ideas');
	});
});

describe('the Unfiled label', () => {
	it('files a doc loose rather than in a folder of that name', () => {
		const doc = write(ALICE, 'Loose', 'personal');
		fileDoc(doc.id, ALICE, { folder: 'unfiled' });
		expect(getDoc(doc.id, ALICE)?.meta.folder).toBe('');
		const saved = saveDoc({ title: 'By agent', body: 'x', author: 'agent', ownerId: ALICE, folder: 'Unfiled' });
		expect(saved.folder).toBe('');
	});
});
