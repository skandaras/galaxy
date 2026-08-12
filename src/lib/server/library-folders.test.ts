import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, runMigrations } from '$lib/server/db';
import { libraryDocs } from '$lib/server/db/schema';
import { cleanFolder, getDoc, libraryDigest, listFolders, saveDoc, searchDocs } from './library';

const ALICE = 'user-alice';
const BOB = 'user-bob';

beforeAll(() => {
	runMigrations();
});

beforeEach(() => {
	db.delete(libraryDocs).run();
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
});
