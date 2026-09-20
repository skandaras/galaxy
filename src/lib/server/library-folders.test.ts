import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, runMigrations } from '$lib/server/db';
import { libraryDocs, libraryFolders } from '$lib/server/db/schema';
import {
	cleanFolder,
	createFolder,
	deleteDoc,
	deleteFolder,
	getDoc,
	libraryDigest,
	listFolders,
	renameFolder,
	saveDoc,
	searchDocs
} from './library';

const ALICE = 'user-alice';
const BOB = 'user-bob';

beforeAll(() => {
	runMigrations();
});

beforeEach(() => {
	db.delete(libraryDocs).run();
	db.delete(libraryFolders).run();
	db.run(sql`DELETE FROM library_fts`);
});

const write = (title: string, folder?: string, owner = ALICE) =>
	saveDoc({ title, body: 'contents', author: 'user', ownerId: owner, folder });

describe('cleanFolder', () => {
	it('tidies whitespace and caps the length', () => {
		expect(cleanFolder('  Recipes  ')).toBe('Recipes');
		expect(cleanFolder('House   notes')).toBe('House notes');
		expect(cleanFolder('x'.repeat(80))).toHaveLength(48);
	});

	it('flattens slashes rather than pretending to nest', () => {
		// A folder is a label on a shelf. Accepting a path would imply moves,
		// renames and orphans that nothing here implements.
		expect(cleanFolder('Home/Kitchen')).toBe('Home Kitchen');
		expect(cleanFolder('a\\b')).toBe('a b');
	});

	it('treats an empty label as unfiled', () => {
		expect(cleanFolder('   ')).toBe('');
	});
});

describe('filing a doc', () => {
	it('keeps the folder it was saved with', () => {
		const doc = write('Roast potatoes', 'Recipes');
		expect(doc.folder).toBe('Recipes');
		expect(getDoc(doc.id, ALICE)?.meta.folder).toBe('Recipes');
	});

	it('starts unfiled when nobody says otherwise', () => {
		expect(write('Loose note').folder).toBe('');
	});

	it('leaves an existing doc where it was filed when the folder is omitted', () => {
		// library_write and any other caller that knows nothing about folders must
		// not quietly unfile a doc just by saving it.
		const doc = write('Roast potatoes', 'Recipes');
		const again = saveDoc({
			id: doc.id,
			title: 'Roast potatoes',
			body: 'new body',
			author: 'user',
			ownerId: ALICE
		});
		expect(again.folder).toBe('Recipes');
	});

	it('moves a doc when a new folder is given, and unfiles it on empty', () => {
		const doc = write('Roast potatoes', 'Recipes');
		const base = { id: doc.id, title: 'Roast potatoes', body: 'b', author: 'user' as const, ownerId: ALICE };
		expect(saveDoc({ ...base, folder: 'Food' }).folder).toBe('Food');
		expect(saveDoc({ ...base, folder: '' }).folder).toBe('');
	});
});

describe('what reaches an agent', () => {
	const SECRET = 'ZEPHYR-MARKER-9';

	it('puts titles in the digest but never their contents', () => {
		// The digest is prepended to every chat and coding turn, so body text in
		// it is paid for on all of them and is almost never what was asked about.
		saveDoc({
			title: 'Roast potatoes',
			body: `Method: ${SECRET} and plenty of goose fat.`,
			author: 'user',
			ownerId: ALICE,
			folder: 'Recipes'
		});
		const digest = libraryDigest(ALICE);
		expect(digest).toContain('Roast potatoes');
		expect(digest).toContain('Recipes');
		expect(digest).not.toContain(SECRET);
	});

	it('finds that content by search instead, returning fragments not documents', () => {
		const body = `${'filler words here. '.repeat(200)} Method: ${SECRET}. ${'more filler. '.repeat(200)}`;
		saveDoc({ title: 'Roast potatoes', body, author: 'user', ownerId: ALICE });

		const hits = searchDocs(SECRET, ALICE);
		expect(hits).toHaveLength(1);
		expect(hits[0].title).toBe('Roast potatoes');
		expect(hits[0].match).toContain(SECRET);
		// The point of the whole arrangement: the match is an excerpt, so a long
		// document costs a line to search rather than its full length.
		expect(hits[0].match.length).toBeLessThan(body.length / 10);
	});

	it('searches titles as well as bodies', () => {
		saveDoc({ title: 'Quarterly budget', body: 'nothing relevant', author: 'user', ownerId: ALICE });
		expect(searchDocs('Quarterly', ALICE).map((d) => d.title)).toEqual(['Quarterly budget']);
	});

	it('keeps one person’s docs out of another’s digest', () => {
		saveDoc({ title: 'Bobs private', body: 'x', author: 'user', ownerId: BOB, folder: 'Bob' });
		expect(libraryDigest(ALICE)).not.toContain('Bobs private');
	});
});

describe('listFolders', () => {
	it('lists the labels in use, sorted and deduplicated', () => {
		write('One', 'Recipes');
		write('Two', 'Recipes');
		write('Three', 'Admin');
		write('Four');
		expect(listFolders(ALICE)).toEqual(['Admin', 'Recipes']);
	});

	it('shows nobody a folder they cannot see the docs of', () => {
		// Folders are derived from visible docs, so a personal doc's label must
		// not leak through the picker.
		write('Bobs thing', 'Bob Only', BOB);
		expect(listFolders(ALICE)).toEqual([]);
		expect(listFolders(BOB)).toEqual(['Bob Only']);
	});

	it('keeps a folder nothing is filed in', () => {
		// The whole reason folders became rows: a name you just typed has to
		// still be there after a reload, before anything is in it.
		createFolder(ALICE, 'Plans');
		expect(listFolders(ALICE)).toEqual(['Plans']);
		expect(listFolders(BOB)).toEqual([]);
	});
});

describe('making a folder', () => {
	it('refuses a name already on the shelf, whatever it came from', () => {
		write('One', 'Recipes');
		expect(createFolder(ALICE, 'Recipes')).toEqual({ ok: false, reason: 'exists' });
		expect(createFolder(ALICE, 'Plans').ok).toBe(true);
		expect(createFolder(ALICE, 'Plans')).toEqual({ ok: false, reason: 'exists' });
		// Someone else's shelf is not yours, so the same name is free there.
		expect(createFolder(BOB, 'Plans').ok).toBe(true);
	});

	it('refuses Unfiled, which every shelf already has', () => {
		expect(createFolder(ALICE, 'Unfiled')).toEqual({ ok: false, reason: 'reserved' });
		expect(createFolder(ALICE, 'unfiled')).toEqual({ ok: false, reason: 'reserved' });
	});

	it('refuses a name that is only whitespace', () => {
		expect(createFolder(ALICE, '   ')).toEqual({ ok: false, reason: 'empty' });
	});

	it('tidies the name the same way a label is tidied', () => {
		const made = createFolder(ALICE, '  Home/Kitchen  ');
		expect(made.ok && made.folder.name).toBe('Home Kitchen');
	});
});

describe('renaming a folder', () => {
	it('takes its documents with it', () => {
		createFolder(ALICE, 'Recipes');
		const doc = write('Roast potatoes', 'Recipes');
		expect(renameFolder(ALICE, 'Recipes', 'Cooking').ok).toBe(true);
		expect(getDoc(doc.id, ALICE)?.meta.folder).toBe('Cooking');
		expect(listFolders(ALICE)).toEqual(['Cooking']);
	});

	it('leaves another person’s documents where they are', () => {
		createFolder(ALICE, 'Recipes');
		const theirs = saveDoc({
			title: 'Their bread',
			body: 'x',
			author: 'user',
			ownerId: BOB,
			visibility: 'shared',
			folder: 'Recipes'
		});
		expect(renameFolder(ALICE, 'Recipes', 'Cooking').ok).toBe(true);
		// Their shared doc is on their shelf too, under the name they filed it
		// under. Renaming your folder is not permission to re-file it.
		expect(getDoc(theirs.id, BOB)?.meta.folder).toBe('Recipes');
	});

	it('refuses someone else’s folder, and a name already taken', () => {
		createFolder(ALICE, 'Recipes');
		createFolder(ALICE, 'Admin');
		expect(renameFolder(BOB, 'Recipes', 'Theirs')).toEqual({ ok: false, reason: 'forbidden' });
		expect(renameFolder(ALICE, 'Recipes', 'Admin')).toEqual({ ok: false, reason: 'exists' });
		// Renaming a folder to what it is already called is not a clash.
		expect(renameFolder(ALICE, 'Recipes', 'Recipes').ok).toBe(true);
	});

	it('renames a folder that is only a label, with no row behind it', () => {
		// Docs filed before folders were rows, and folders that only exist
		// because a shared doc carries the label, both land here.
		const doc = write('Boiler manual', 'House');
		expect(renameFolder(ALICE, 'House', 'Home').ok).toBe(true);
		expect(getDoc(doc.id, ALICE)?.meta.folder).toBe('Home');
		expect(listFolders(ALICE)).toEqual(['Home']);
		// And it is a row now, so emptying it does not make it disappear.
		expect(deleteDoc(doc.id, ALICE)).toBe(true);
		expect(listFolders(ALICE)).toEqual(['Home']);
	});

	it('moves a doc that predates ownership, which is everyone’s', () => {
		const doc = saveDoc({ title: 'Ancient', body: 'x', author: 'user', ownerId: ALICE, folder: 'Old' });
		db.update(libraryDocs).set({ ownerId: null }).where(eq(libraryDocs.id, doc.id)).run();
		expect(renameFolder(ALICE, 'Old', 'New').ok).toBe(true);
		// canEdit says an ownerless doc is anyone's to change; the predicate the
		// rename uses has to give the same answer.
		expect(getDoc(doc.id, ALICE)?.meta.folder).toBe('New');
	});
});

describe('deleting a folder', () => {
	it('drops its documents into Unfiled rather than deleting them', () => {
		createFolder(ALICE, 'Recipes');
		const doc = write('Roast potatoes', 'Recipes');
		expect(deleteFolder(ALICE, 'Recipes')).toBe(true);
		// The same answer deleteDoc gives its children: of refuse, cascade and
		// promote, only one cannot lose a document to a click on the wrong row.
		expect(getDoc(doc.id, ALICE)?.meta.folder).toBe('');
		expect(listFolders(ALICE)).toEqual([]);
	});

	it('refuses someone else’s folder', () => {
		createFolder(ALICE, 'Recipes');
		expect(deleteFolder(BOB, 'Recipes')).toBe(false);
		expect(listFolders(ALICE)).toEqual(['Recipes']);
	});
});
