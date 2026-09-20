import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { and, desc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { db, dataDir } from '$lib/server/db';
import { libraryDocs, libraryFolders } from '$lib/server/db/schema';
import { SEARCH_LIMIT } from '$lib/library-search';
import { UNFILED } from '$lib/library-tree';

export type LibraryDoc = typeof libraryDocs.$inferSelect;

const libraryDir = () => join(dataDir, 'library');

export function slugify(title: string): string {
	return (
		title
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 64) || 'untitled'
	);
}

/** Longest a folder label may be; it has to fit a narrow shelf. */
const MAX_FOLDER = 48;

/**
 * Tidy a folder label. Flat by design — a slash is just a character in a name,
 * not a hierarchy, because nesting brings moves, renames and orphans with it
 * and this is a way of grouping a shelf, nothing more.
 */
export function cleanFolder(raw: string): string {
	return raw.replace(/[\\/]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_FOLDER);
}

export type LibraryFolder = typeof libraryFolders.$inferSelect;

export type FolderResult =
	| { ok: true; folder: LibraryFolder }
	| { ok: false; reason: 'empty' | 'reserved' | 'exists' | 'forbidden' };

/**
 * Every folder on this user's shelf: the ones they made, and the labels their
 * visible docs are filed under.
 *
 * The union is the point. A shared doc carries its own label, and that label is
 * a folder on your shelf whether or not you have a row for it — which is how
 * the shelf worked when a label was all a folder ever was. The rows only have
 * to make a folder exist while nothing is filed in it.
 */
export function listFolders(userId: string): string[] {
	const own = db
		.select({ name: libraryFolders.name })
		.from(libraryFolders)
		.where(eq(libraryFolders.ownerId, userId))
		.all()
		.map((r) => r.name);
	const used = listDocs(userId).map((d) => d.folder);
	return [...new Set([...own, ...used].filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

/**
 * Folders are addressed by name, not by row id.
 *
 * The label on the document is the join, so a folder can exist with no row
 * behind it — one an older release filed docs into, or one that is only a
 * label on somebody's shared doc. Addressing by id would leave those two
 * unrenameable for no reason a person could see.
 */
const folderRow = (name: string, userId: string) =>
	db
		.select()
		.from(libraryFolders)
		.where(and(eq(libraryFolders.name, name), eq(libraryFolders.ownerId, userId)))
		.get();

/** Whether this user has anything filed under a label, row or no row. */
const folderInUse = (name: string, userId: string) =>
	!!db
		.select({ id: libraryDocs.id })
		.from(libraryDocs)
		.where(and(eq(libraryDocs.folder, name), ownedBy(userId)))
		.get();

/** Unfiled is the overflow every shelf has and nobody owns, so nobody may name one. */
const isReserved = (name: string) => name.toLowerCase() === UNFILED.toLowerCase();

function insertFolder(userId: string, name: string): LibraryFolder {
	const folder: LibraryFolder = {
		id: uniqueSlug(slugify(name), folderIdTaken),
		name,
		ownerId: userId,
		createdAt: new Date()
	};
	db.insert(libraryFolders).values(folder).run();
	return folder;
}

export function createFolder(userId: string, rawName: string): FolderResult {
	const name = cleanFolder(rawName);
	if (!name) return { ok: false, reason: 'empty' };
	if (isReserved(name)) return { ok: false, reason: 'reserved' };
	// Against the union rather than the table: a label already in use by a
	// visible doc is a folder you can see, and a second row of that name would
	// draw it twice.
	if (listFolders(userId).includes(name)) return { ok: false, reason: 'exists' };
	return { ok: true, folder: insertFolder(userId, name) };
}

/**
 * Rename a folder, and the docs filed under it.
 *
 * Only this user's docs move: someone else's shared doc under the same label
 * sits on their shelf too, and renaming your folder is not permission to
 * re-file it.
 *
 * Deliberately does not touch `updatedAt` on the docs it moves. The shelf and
 * the digest are both ordered by it, and a rename that shoved every doc in a
 * folder to the top of the list would read as a fortnight of edits nobody made.
 */
export function renameFolder(userId: string, from: string, rawName: string): FolderResult {
	const row = folderRow(from, userId);
	if (!row && !folderInUse(from, userId)) return { ok: false, reason: 'forbidden' };
	const name = cleanFolder(rawName);
	if (!name) return { ok: false, reason: 'empty' };
	if (isReserved(name)) return { ok: false, reason: 'reserved' };
	if (name !== from && listFolders(userId).includes(name)) return { ok: false, reason: 'exists' };
	db.update(libraryDocs)
		.set({ folder: name })
		.where(and(eq(libraryDocs.folder, from), ownedBy(userId)))
		.run();
	if (row) {
		db.update(libraryFolders).set({ name }).where(eq(libraryFolders.id, row.id)).run();
		return { ok: true, folder: { ...row, name } };
	}
	// A folder that was only a label gets a row on first rename, the way
	// setVisibility claims a legacy doc the first time somebody changes it —
	// otherwise emptying it later would make the folder vanish mid-tidy. Not
	// through createFolder, which would refuse: the docs already carry the name.
	return { ok: true, folder: insertFolder(userId, name) };
}

/**
 * Drop a folder. Its docs fall back to Unfiled rather than being deleted.
 *
 * The same answer `deleteDoc` gives its children: of the three options it is
 * the only one that cannot lose a document to one click on the wrong row.
 */
export function deleteFolder(userId: string, name: string): boolean {
	const row = folderRow(name, userId);
	if (!row && !folderInUse(name, userId)) return false;
	db.update(libraryDocs)
		.set({ folder: '' })
		.where(and(eq(libraryDocs.folder, name), ownedBy(userId)))
		.run();
	if (row) db.delete(libraryFolders).where(eq(libraryFolders.id, row.id)).run();
	return true;
}

/** Crude markdown-stripped preview used in listings and the agent digest. */
export function makeSnippet(body: string, max = 180): string {
	return body
		.replace(/^---[\s\S]*?---/, '')
		.replace(/[#*_>`[\]()]/g, '')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, max);
}

/**
 * What one user may see: their own docs, anything shared, and anything with no
 * owner at all.
 *
 * The last case is the library as it was before ownership existed — every doc
 * was global and reached every agent's context. Those rows keep behaving that
 * way rather than vanishing from someone's shelf on upgrade.
 *
 * Every read goes through this. The library is the one store that feeds
 * *another* user's prompt, so an unscoped query here is a privacy bug, not a
 * cosmetic one.
 */
export function visibleTo(userId: string): SQL {
	return or(
		eq(libraryDocs.visibility, 'shared'),
		eq(libraryDocs.ownerId, userId),
		isNull(libraryDocs.ownerId)
	)!;
}

/** True when this user may change or delete the doc — owners and legacy only. */
export function canEdit(doc: Pick<LibraryDoc, 'ownerId'>, userId: string): boolean {
	return doc.ownerId === null || doc.ownerId === userId;
}

/**
 * `canEdit` as a predicate, for the writes that act on a set of rows.
 *
 * A folder rename moves documents, so it needs the same answer in SQL that
 * `canEdit` gives one row at a time — including the ownerless rows that
 * predate ownership, which are everyone's to change.
 */
export function ownedBy(userId: string): SQL {
	return or(eq(libraryDocs.ownerId, userId), isNull(libraryDocs.ownerId))!;
}

export function listDocs(userId: string): LibraryDoc[] {
	return db
		.select()
		.from(libraryDocs)
		.where(visibleTo(userId))
		.orderBy(desc(libraryDocs.updatedAt))
		.all();
}

export function getDoc(id: string, userId: string): { meta: LibraryDoc; body: string } | null {
	const meta = db
		.select()
		.from(libraryDocs)
		.where(and(eq(libraryDocs.id, id), visibleTo(userId)))
		.get();
	if (!meta) return null;
	const path = join(libraryDir(), `${id}.md`);
	return { meta, body: existsSync(path) ? readFileSync(path, 'utf8') : '' };
}

export function findDocByTitle(title: string, userId: string): LibraryDoc | null {
	const t = title.trim().toLowerCase();
	return (
		listDocs(userId).find((d) => d.title.toLowerCase() === t || d.id === slugify(title)) ?? null
	);
}

/**
 * How deep a doc may sit. Root is 1, so this allows epic → sprint → task → note
 * with a level spare.
 *
 * A bound rather than a preference: every walk in this section is written to
 * terminate after this many hops whatever the data says, which is what makes an
 * already-cyclic row a refusal rather than a hang.
 */
export const MAX_DEPTH = 5;

const rowById = (id: string) => db.select().from(libraryDocs).where(eq(libraryDocs.id, id)).get();

/** The tree a doc belongs to. Stored rows may predate the column; see the schema. */
const rootOf = (doc: Pick<LibraryDoc, 'id' | 'rootId'>) => doc.rootId ?? doc.id;

export type PlaceResult = { ok: true } | { ok: false; reason: 'cycle' | 'depth' | 'no-parent' };

/**
 * Whether `docId` may sit under `parentId`.
 *
 * Structural only — it says nothing about who may see either doc, and callers
 * do that scoping themselves so it is visible at the call site rather than
 * buried here.
 */
export function canPlace(docId: string | null, parentId: string | null): PlaceResult {
	if (!parentId) return { ok: true };
	let cursor: string | null = parentId;
	// One more hop than the limit: reaching the end of this loop with a parent
	// still to follow means the chain is longer than a tree can be, which is
	// either too deep or a cycle that does not pass through docId.
	for (let depth = 1; depth <= MAX_DEPTH; depth++) {
		if (cursor === docId) return { ok: false, reason: 'cycle' };
		const row: LibraryDoc | undefined = rowById(cursor);
		if (!row) return { ok: false, reason: 'no-parent' };
		if (!row.parentId) return depth < MAX_DEPTH ? { ok: true } : { ok: false, reason: 'depth' };
		cursor = row.parentId;
	}
	return { ok: false, reason: 'depth' };
}

/**
 * Rewrite `rootId` and `folder` across a subtree. Bounded by MAX_DEPTH, so it
 * cannot spin.
 *
 * The folder rides along because a subtree belongs to exactly one folder — the
 * one its root is filed in. Without it, moving an epic to another folder left
 * its sprint records claiming the old one, and deleting a root promoted its
 * children into a folder heading that had nothing to do with them.
 */
function repointSubtree(id: string, rootId: string, folder: string): void {
	let level = [id];
	for (let depth = 0; depth < MAX_DEPTH && level.length; depth++) {
		db.update(libraryDocs)
			.set({ rootId, folder })
			.where(inArray(libraryDocs.id, level))
			.run();
		level = db
			.select({ id: libraryDocs.id })
			.from(libraryDocs)
			.where(inArray(libraryDocs.parentId, level))
			.all()
			.map((r) => r.id);
	}
}

export type MoveResult =
	| { ok: true; doc: LibraryDoc }
	| { ok: false; reason: 'cycle' | 'depth' | 'no-parent' | 'forbidden' };

/** Where a doc is being filed: inside another doc, or loose in a folder. */
export type FilingDest = { parentId: string } | { folder: string };

/**
 * Re-file a doc — under another doc, or as a root of a folder.
 *
 * Its own function rather than a `saveDoc` argument because moving through
 * `saveDoc` would mean handing it the whole body again to change one pointer —
 * and the body is on disk, so that is a read and a write of the file for a
 * column update. Dragging a row does this once per drop, which is the case that
 * makes the difference.
 *
 * There is no "top level" destination any more. Everything a person can drop a
 * doc on is a folder or another doc, because the shelf has nothing else on it.
 */
export function fileDoc(id: string, userId: string, dest: FilingDest): MoveResult {
	const doc = rowById(id);
	if (!doc || !canEdit(doc, userId)) return { ok: false, reason: 'forbidden' };

	let parentId: string | null = null;
	let rootId = id;
	let folder: string;
	if ('parentId' in dest) {
		// Filing under something you cannot see would put your doc in a tree whose
		// shape you have no way to inspect.
		const parent = db
			.select()
			.from(libraryDocs)
			.where(and(eq(libraryDocs.id, dest.parentId), visibleTo(userId)))
			.get();
		if (!parent) return { ok: false, reason: 'no-parent' };
		const placed = canPlace(id, dest.parentId);
		if (!placed.ok) return placed;
		parentId = dest.parentId;
		rootId = rootOf(parent);
		folder = parent.folder;
	} else {
		folder = cleanFolder(dest.folder);
	}

	db.update(libraryDocs)
		.set({ parentId, rootId, folder, updatedAt: new Date() })
		.where(eq(libraryDocs.id, id))
		.run();
	repointSubtree(id, rootId, folder);
	return { ok: true, doc: rowById(id)! };
}

/** Titles from the root down to this doc, for a breadcrumb. */
export function docPath(id: string, userId: string): string[] {
	const path: string[] = [];
	let cursor: string | null = id;
	for (let depth = 0; depth <= MAX_DEPTH && cursor; depth++) {
		const row: LibraryDoc | undefined = db
			.select()
			.from(libraryDocs)
			.where(and(eq(libraryDocs.id, cursor), visibleTo(userId)))
			.get();
		// An ancestor this person cannot see ends the path rather than being
		// named: the breadcrumb must not leak a title out of someone else's shelf.
		if (!row) break;
		path.unshift(row.title);
		cursor = row.parentId;
	}
	return path;
}

/**
 * Each folder and how many visible documents are in it.
 *
 * One grouped read: this answers `library_tree` called with nothing, which is
 * now the top of the shelf rather than a list of every root.
 */
export function listFolderCounts(userId: string): { name: string; count: number }[] {
	const rows = db.all<{ folder: string; n: number }>(
		sql`SELECT folder, COUNT(*) AS n FROM library_docs
		    WHERE ${visibleTo(userId)} GROUP BY folder`
	);
	const counts = new Map(rows.filter((r) => r.folder).map((r) => [r.folder, r.n]));
	for (const name of db
		.select({ name: libraryFolders.name })
		.from(libraryFolders)
		.where(eq(libraryFolders.ownerId, userId))
		.all()) {
		if (!counts.has(name.name)) counts.set(name.name, 0);
	}
	const loose = rows.find((r) => !r.folder)?.n ?? 0;
	return [
		...[...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, count]) => ({ name, count })),
		// Unfiled is drawn only when something is loose in it: it is the overflow,
		// and an empty one is a line about nothing.
		...(loose ? [{ name: UNFILED, count: loose }] : [])
	];
}

/** The documents at the top of a folder — its roots, newest first. */
export function listFolderRoots(folder: string, userId: string): LibraryDoc[] {
	return db
		.select()
		.from(libraryDocs)
		.where(
			and(visibleTo(userId), isNull(libraryDocs.parentId), eq(libraryDocs.folder, folder))
		)
		.orderBy(desc(libraryDocs.updatedAt))
		.all();
}

/** One node's children, newest first. Null lists the roots. */
export function listChildren(parentId: string | null, userId: string): LibraryDoc[] {
	return db
		.select()
		.from(libraryDocs)
		.where(
			and(visibleTo(userId), parentId ? eq(libraryDocs.parentId, parentId) : isNull(libraryDocs.parentId))
		)
		.orderBy(desc(libraryDocs.updatedAt))
		.all();
}

/**
 * How many visible docs sit in each tree, keyed by root id.
 *
 * One grouped read, which is the whole reason `rootId` is denormalised — this
 * runs on every chat and coding turn through the digest.
 */
export function subtreeCounts(userId: string): Map<string, number> {
	const rows = db.all<{ root: string; n: number }>(
		sql`SELECT COALESCE(root_id, id) AS root, COUNT(*) AS n
		    FROM library_docs WHERE ${visibleTo(userId)} GROUP BY root`
	);
	return new Map(rows.map((r) => [r.root, r.n]));
}

/**
 * Thrown by saveDoc, which returns a row rather than a result object.
 *
 * `fileDoc` answers with a result instead, because re-filing is a thing a person
 * does and a refusal is a message on a form. A bad parent reaching saveDoc is a
 * caller that built one, and its routes turn this into a 400.
 */
export class LibraryTreeError extends Error {
	constructor(public reason: 'cycle' | 'depth' | 'no-parent') {
		super(`Cannot file a document there: ${reason}`);
	}
}

export function saveDoc(opts: {
	id?: string;
	title: string;
	body: string;
	author: 'user' | 'agent';
	/** Owner for a new doc. Existing docs keep the owner they have. */
	ownerId: string;
	/** New docs start personal; sharing is a deliberate act. */
	visibility?: 'personal' | 'shared';
	/** Which folder a root sits in. Ignored when parentId names a parent. */
	folder?: string;
	/** Where in the tree. Omitted leaves an existing doc where it sits. */
	parentId?: string | null;
}): LibraryDoc {
	mkdirSync(libraryDir(), { recursive: true });
	const now = new Date();
	const existing = opts.id
		? db.select().from(libraryDocs).where(eq(libraryDocs.id, opts.id)).get()
		: null;
	const id = existing?.id ?? uniqueSlug(slugify(opts.title), docIdTaken);
	const snippet = makeSnippet(opts.body);

	writeFileSync(join(libraryDir(), `${id}.md`), opts.body);

	// An omitted parent means "leave it where it sits", so that a save from
	// somewhere with no notion of the tree — the memory job, a plain edit — does
	// not lift a doc out of it.
	const parentId = opts.parentId === undefined ? (existing?.parentId ?? null) : opts.parentId;
	if (parentId && parentId !== existing?.parentId) {
		const placed = canPlace(existing?.id ?? id, parentId);
		if (!placed.ok) throw new LibraryTreeError(placed.reason);
	}
	const parent = parentId ? rowById(parentId) : null;
	// A root's rootId is its own id, never null — the digest groups on it.
	const rootId = parent ? rootOf(parent) : id;

	// The parent's folder wins over anything the caller asked for: a doc nested
	// inside another is in that doc's folder by definition, and a subtree that
	// straddles two headings is a tree with two homes on one shelf. Only a root
	// carries a label of its own, and an omitted one leaves it where it was
	// filed rather than quietly unfiling it.
	const folder = parent
		? parent.folder
		: opts.folder === undefined
			? (existing?.folder ?? '')
			: cleanFolder(opts.folder);

	const row: LibraryDoc = {
		id,
		title: opts.title.trim() || id,
		snippet,
		author: existing?.author ?? opts.author,
		ownerId: existing ? existing.ownerId : opts.ownerId,
		visibility: existing ? existing.visibility : (opts.visibility ?? 'personal'),
		folder,
		parentId,
		rootId,
		sizeBytes: Buffer.byteLength(opts.body),
		createdAt: existing?.createdAt ?? now,
		updatedAt: now
	};
	if (existing) {
		db.update(libraryDocs)
			.set({
				title: row.title,
				snippet,
				folder,
				parentId,
				rootId,
				sizeBytes: row.sizeBytes,
				updatedAt: now
			})
			.where(eq(libraryDocs.id, id))
			.run();
		// Moving by save is legal, and its descendants have to come along — see
		// fileDoc, which is the same write without the body round trip.
		if (
			existing.parentId !== parentId ||
			existing.rootId !== rootId ||
			existing.folder !== folder
		) {
			repointSubtree(id, rootId, folder);
		}
	} else {
		db.insert(libraryDocs).values(row).run();
	}
	db.run(sql`DELETE FROM library_fts WHERE id = ${id}`);
	db.run(sql`INSERT INTO library_fts (id, title, body) VALUES (${id}, ${row.title}, ${opts.body})`);
	return row;
}

/** Change who can see a doc. Only its owner (or a legacy doc) can be changed. */
export function setVisibility(
	id: string,
	userId: string,
	visibility: 'personal' | 'shared'
): LibraryDoc | null {
	const meta = db.select().from(libraryDocs).where(eq(libraryDocs.id, id)).get();
	if (!meta || !canEdit(meta, userId)) return null;
	db.update(libraryDocs)
		// Claim a legacy doc on first change, so it stops being everyone's.
		.set({ visibility, ownerId: meta.ownerId ?? userId, updatedAt: new Date() })
		.where(eq(libraryDocs.id, id))
		.run();
	return db.select().from(libraryDocs).where(eq(libraryDocs.id, id)).get() ?? null;
}

export function deleteDoc(id: string, userId: string): boolean {
	const meta = db.select().from(libraryDocs).where(eq(libraryDocs.id, id)).get();
	// Someone else's shared doc is readable, not deletable.
	if (!meta || !canEdit(meta, userId)) return false;

	/**
	 * Children are promoted to the deleted doc's own parent.
	 *
	 * The two alternatives are both worse. Refusing to delete a doc that has
	 * children makes removing a finished epic an N-step chore, bottom up.
	 * Cascading loses a fortnight of records to one click on the wrong row.
	 * Promotion is the only one of the three that cannot lose a document, and it
	 * is why nesting does not bring orphans with it.
	 */
	const orphans = db
		.select({ id: libraryDocs.id })
		.from(libraryDocs)
		.where(eq(libraryDocs.parentId, id))
		.all();
	if (orphans.length) {
		db.update(libraryDocs)
			.set({ parentId: meta.parentId })
			.where(eq(libraryDocs.parentId, id))
			.run();
		// Only a deleted *root* changes which tree its children are in: promoted
		// into a parent, they stay where they were. Either way they keep the
		// folder they were in, which is the one the deleted doc was filed under.
		if (!meta.parentId) for (const o of orphans) repointSubtree(o.id, o.id, meta.folder);
	}

	db.delete(libraryDocs).where(eq(libraryDocs.id, id)).run();
	db.run(sql`DELETE FROM library_fts WHERE id = ${id}`);
	rmSync(join(libraryDir(), `${id}.md`), { force: true });
	return true;
}

export function searchDocs(
	query: string,
	userId: string,
	limit = SEARCH_LIMIT
): (LibraryDoc & { match: string })[] {
	const rows = db.all<{ id: string; match: string }>(
		sql`SELECT id, snippet(library_fts, 2, '«', '»', '…', 12) AS match
		    FROM library_fts WHERE library_fts MATCH ${ftsQuery(query)}
		    ORDER BY rank LIMIT ${limit}`
	);
	// Scoped by construction: only visible docs are in the map, so an FTS hit on
	// someone else's personal doc is dropped here.
	const metas = new Map(listDocs(userId).map((d) => [d.id, d]));
	return rows
		.filter((r) => metas.has(r.id))
		.map((r) => ({ ...metas.get(r.id)!, match: r.match }));
}

/**
 * Words too common to narrow anything, dropped from an `any` match. bm25 would
 * weight them near zero anyway; the reason to drop them outright is that a
 * query made *entirely* of them would otherwise match the whole table.
 */
const FTS_STOPWORDS = new Set([
	'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'do', 'for', 'from',
	'had', 'has', 'have', 'he', 'her', 'his', 'how', 'i', 'in', 'is', 'it', 'its', 'me',
	'my', 'no', 'not', 'of', 'on', 'or', 'our', 'she', 'so', 'that', 'the', 'their',
	'them', 'then', 'there', 'these', 'they', 'this', 'to', 'was', 'we', 'were', 'what',
	'when', 'which', 'who', 'why', 'will', 'with', 'you', 'your'
]);

/**
 * Quote terms so user input can't break FTS5 query syntax.
 *
 * Exported because Cortex seeds its traversals from an FTS table too, and this
 * hazard is worth solving once rather than in every module that opens one.
 *
 * `match` decides what a multi-word query means, and the two callers genuinely
 * want different things. Library search is given deliberate keywords, so *all*
 * — FTS5's implicit AND — is right: asking for two words and being shown
 * documents containing one of them is not a search.
 *
 * Cortex is given a sentence someone said. A natural-language query is almost
 * never a term-for-term subset of the text it should match — "cliff edge
 * retreating" against a node that says "retreats" already fails — so AND finds
 * nothing at all, silently, which is the same failure the keyword map it
 * replaced would have had. *any* matches on whatever overlaps and lets bm25
 * rank by how much did.
 */
export function ftsQuery(q: string, match: 'all' | 'any' = 'all'): string {
	const terms = q.split(/\s+/).filter(Boolean);
	const kept =
		match === 'any'
			? terms.filter((t) => t.length >= 3 && !FTS_STOPWORDS.has(t.toLowerCase()))
			: terms;
	return kept
		.slice(0, 8)
		.map((t) => `"${t.replace(/"/g, '')}"`)
		.join(match === 'any' ? ' OR ' : ' ');
}

const docIdTaken = (id: string) =>
	!!db.select().from(libraryDocs).where(eq(libraryDocs.id, id)).get();
const folderIdTaken = (id: string) =>
	!!db.select().from(libraryFolders).where(eq(libraryFolders.id, id)).get();

/** `taken` rather than one hard-coded table: folders are slugged the same way. */
function uniqueSlug(base: string, taken: (id: string) => boolean): string {
	let candidate = base;
	for (let i = 2; taken(candidate); i++) {
		candidate = `${base}-${i}`;
	}
	return candidate;
}

/**
 * Index of the Library for the agent context bootstrap: what exists, not what
 * it says.
 *
 * This block is prepended to *every* chat and coding turn, so its cost is paid
 * on each one. It used to carry a 120-character snippet of every document —
 * around 5,000 characters of body text per turn at thirty docs, almost none of
 * it relevant to the question being asked, and it grew with the shelf.
 *
 * Titles and folders are enough to decide what to open; library_search reads
 * the content properly, matching on title and body, and returns only the
 * matching fragments.
 */
/** Agent-written docs are marked, wherever an agent reads a list of them. */
const authored = (title: string, author: string) => `${title}${author === 'agent' ? ' [agent]' : ''}`;

export function libraryDigest(userId: string, maxRoots = 40): string {
	// The window is roots rather than documents, which is the whole point: a
	// subtree costs one line whether it holds five documents or five hundred, so
	// filing every task of a build no longer evicts somebody's own notes from
	// the block that every turn in the app pays for.
	const roots = db
		.select({
			id: libraryDocs.id,
			title: libraryDocs.title,
			folder: libraryDocs.folder,
			author: libraryDocs.author
		})
		.from(libraryDocs)
		.where(and(visibleTo(userId), isNull(libraryDocs.parentId)))
		.orderBy(desc(libraryDocs.updatedAt))
		.limit(maxRoots)
		.all();
	// Folders with nothing in them, which the roots cannot name. Read straight
	// off the table rather than through listFolders, which reads every visible
	// document to build its union — too much for a block on the hot path.
	const empty = db
		.select({ name: libraryFolders.name })
		.from(libraryFolders)
		.where(eq(libraryFolders.ownerId, userId))
		.all()
		.map((r) => r.name);
	if (!roots.length && !empty.length) return '(library is empty)';
	const counts = subtreeCounts(userId);

	/**
	 * A folder, and what sits at the top of it — never what is nested inside
	 * that.
	 *
	 * This used to name a small tree's children, which meant an agent reading
	 * the index saw two shapes: folders, and documents that were somehow also
	 * folders. It is one shape now, matching what a person sees on the shelf,
	 * and a nested document costs nothing at all — which is the whole argument
	 * for nesting rather than adding another line to every turn in the app.
	 */
	const byFolder = new Map<string, string[]>();
	for (const name of empty) byFolder.set(name, []);
	for (const r of roots) {
		const under = (counts.get(r.id) ?? 1) - 1;
		const line = `${authored(r.title, r.author)}${under > 0 ? ` (${under} beneath)` : ''}`;
		byFolder.set(r.folder, [...(byFolder.get(r.folder) ?? []), line]);
	}

	const lines = [...byFolder.entries()]
		.sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))
		.map(([folder, titles]) => `- ${folder || UNFILED}: ${titles.join(' · ') || '(empty)'}`);

	if (roots.length === maxRoots) {
		const total =
			db.get<{ n: number }>(
				sql`SELECT COUNT(*) AS n FROM library_docs
				    WHERE ${visibleTo(userId)} AND parent_id IS NULL`
			)?.n ?? roots.length;
		if (total > roots.length) lines.push(`…and ${total - roots.length} more.`);
	}
	lines.push(
		'Use library_tree to open a folder or a document, library_search to search their contents, library_read to read one.'
	);
	return lines.join('\n');
}
