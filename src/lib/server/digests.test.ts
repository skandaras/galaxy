import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, runMigrations } from '$lib/server/db';
import { boardMembers, boards, cards, libraryDocs } from '$lib/server/db/schema';
import { createBoard, createCard } from '$lib/server/boards';
import { libraryDigest, saveDoc } from '$lib/server/library';
import { boardsDigest } from './engine/tools/boards';

/**
 * The context bootstrap's digests, which run once per turn for every agent.
 *
 * Each of these used to read a whole table in order to show a handful of lines
 * from it — and the boards line fetched every card of every board so that it
 * could take `.length`. The bounds now live in SQL, so what these hold down is
 * that the *output* did not change while the queries behind it did.
 */

const USER = 'user-digest';

beforeAll(() => runMigrations());

beforeEach(() => {
	db.delete(cards).run();
	db.delete(boardMembers).run();
	db.delete(boards).run();
	db.delete(libraryDocs).run();
	db.run(`DELETE FROM library_fts`);
});

const board = (name: string) => createBoard({ ownerId: USER, name }).id;

const card = (boardId: string, archived = false) => {
	const c = createCard(boardId, USER, { title: 'c' })!;
	if (archived) {
		db.update(cards).set({ archivedAt: new Date() }).where(eq(cards.id, c.id)).run();
	}
};

describe('boardsDigest', () => {
	it('counts open cards per board without reading them', () => {
		const a = board('Alpha');
		const b = board('Beta');
		card(a);
		card(a);
		card(a, true); // archived — not open
		card(b);

		const out = boardsDigest(USER);
		expect(out).toContain('- Alpha: 2 open cards');
		expect(out).toContain('- Beta: 1 open card');
	});

	it('says so when a board is empty, rather than omitting it', () => {
		board('Empty');
		expect(boardsDigest(USER)).toContain('- Empty: 0 open cards');
	});

	it('has a line for someone with no boards at all', () => {
		expect(boardsDigest(USER)).toBe('(no boards)');
	});
});

describe('libraryDigest', () => {
	it('groups titles by folder', () => {
		saveDoc({ title: 'One', body: 'a', folder: 'Notes', author: 'user', ownerId: USER });
		saveDoc({ title: 'Two', body: 'b', author: 'user', ownerId: USER });
		const out = libraryDigest(USER);
		expect(out).toContain('Notes: One');
		expect(out).toContain('Unfiled: Two');
	});

	it('counts the remainder past the cap it actually fetched', () => {
		// The cap is a LIMIT now, so the "…and N more" line can no longer be
		// derived from the rows in hand — it comes from a separate count, and
		// getting that wrong would silently misreport the size of the Library.
		for (let i = 0; i < 12; i++) saveDoc({ title: `Doc ${i}`, body: 'x', author: 'user', ownerId: USER });
		expect(libraryDigest(USER, 5)).toContain('…and 7 more.');
	});

	it('adds no remainder line when everything fits', () => {
		for (let i = 0; i < 3; i++) saveDoc({ title: `Doc ${i}`, body: 'x', author: 'user', ownerId: USER });
		expect(libraryDigest(USER, 5)).not.toContain('more.');
	});

	it('says the library is empty rather than returning nothing', () => {
		expect(libraryDigest(USER)).toBe('(library is empty)');
	});
});
