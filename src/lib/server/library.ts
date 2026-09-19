import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { and, desc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { db, dataDir } from '$lib/server/db';
import { libraryDocs } from '$lib/server/db/schema';
import { SEARCH_LIMIT } from '$lib/library-search';

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

/** Folder labels in use, for the picker. Only ones this user can see. */
export function listFolders(userId: string): string[] {
	return [...new Set(listDocs(userId).map((d) => d.folder).filter(Boolean))].sort((a, b) =>
		a.localeCompare(b)
	);
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

/** Rewrite `rootId` across a subtree. Bounded by MAX_DEPTH, so it cannot spin. */
function repointSubtree(id: string, rootId: string): void {
	let level = [id];
	for (let depth = 0; depth < MAX_DEPTH && level.length; depth++) {
		db.update(libraryDocs)
			.set({ rootId })
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

/**
 * Re-file a doc under a different parent, or at the top with null.
 *
 * Its own function rather than a `saveDoc` argument because moving through
 * `saveDoc` would mean handing it the whole body again to change one pointer —
 * and the body is on disk, so that is a read and a write of the file for a
 * column update.
 */
export function moveDoc(id: string, userId: string, parentId: string | null): MoveResult {
	const doc = rowById(id);
	if (!doc || !canEdit(doc, userId)) return { ok: false, reason: 'forbidden' };
	if (parentId) {
		// Filing under something you cannot see would put your doc in a tree whose
		// shape you have no way to inspect.
		const parent = db
			.select()
			.from(libraryDocs)
			.where(and(eq(libraryDocs.id, parentId), visibleTo(userId)))
			.get();
		if (!parent) return { ok: false, reason: 'no-parent' };
	}
	const placed = canPlace(id, parentId);
	if (!placed.ok) return placed;

	const parent = parentId ? rowById(parentId) : null;
	const rootId = parent ? rootOf(parent) : id;
	db.update(libraryDocs)
		.set({ parentId, rootId, updatedAt: new Date() })
		.where(eq(libraryDocs.id, id))
		.run();
	repointSubtree(id, rootId);
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
 * `moveDoc` answers with a result instead, because re-filing is a thing a person
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
	/** Cosmetic grouping. Omitted leaves an existing doc where it was filed. */
	folder?: string;
	/** Where in the tree. Omitted leaves an existing doc where it sits. */
	parentId?: string | null;
}): LibraryDoc {
	mkdirSync(libraryDir(), { recursive: true });
	const now = new Date();
	const existing = opts.id
		? db.select().from(libraryDocs).where(eq(libraryDocs.id, opts.id)).get()
		: null;
	const id = existing?.id ?? uniqueSlug(slugify(opts.title));
	const snippet = makeSnippet(opts.body);

	writeFileSync(join(libraryDir(), `${id}.md`), opts.body);

	// An omitted folder means "leave it where it is", so that saving a doc from
	// anywhere that doesn't know about folders cannot quietly unfile it.
	const folder =
		opts.folder === undefined ? (existing?.folder ?? '') : cleanFolder(opts.folder);

	// Same rule as folder, and for the same reason: a save from somewhere with no
	// notion of the tree — the memory job, a plain edit — must not lift a doc out
	// of it.
	const parentId = opts.parentId === undefined ? (existing?.parentId ?? null) : opts.parentId;
	if (parentId && parentId !== existing?.parentId) {
		const placed = canPlace(existing?.id ?? id, parentId);
		if (!placed.ok) throw new LibraryTreeError(placed.reason);
	}
	const parent = parentId ? rowById(parentId) : null;
	// A root's rootId is its own id, never null — the digest groups on it.
	const rootId = parent ? rootOf(parent) : id;

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
		// moveDoc, which is the same write without the body round trip.
		if (existing.parentId !== parentId || existing.rootId !== rootId) repointSubtree(id, rootId);
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
		// into a parent, they stay where they were.
		if (!meta.parentId) for (const o of orphans) repointSubtree(o.id, o.id);
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

function uniqueSlug(base: string): string {
	let candidate = base;
	for (let i = 2; db.select().from(libraryDocs).where(eq(libraryDocs.id, candidate)).get(); i++) {
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
/** Below this, naming a tree's children beats counting them. */
const LIST_CHILDREN_UPTO = 3;

const authored = (title: string, author: string) => `${title}${author === 'agent' ? ' [agent]' : ''}`;

export function libraryDigest(userId: string, maxRoots = 40): string {
	// The window is roots rather than documents, which is the whole point: a
	// subtree costs one line whether it holds five documents or five hundred, so
	// filing every task of an epic no longer evicts somebody's own notes from
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
	if (!roots.length) return '(library is empty)';
	const counts = subtreeCounts(userId);

	// A root with nothing under it is a document, not a tree, so it groups by its
	// folder label exactly as it did before there were trees. Without this every
	// existing shelf — where each document is its own root — would go from a
	// handful of folder lines to one line per document, which is the opposite of
	// what this change is for.
	const trees = roots.filter((r) => (counts.get(r.id) ?? 1) > 1);
	const loose = roots.filter((r) => (counts.get(r.id) ?? 1) <= 1);

	const small = trees.filter((t) => (counts.get(t.id) ?? 1) <= LIST_CHILDREN_UPTO + 1);
	const childTitles = new Map<string, string[]>();
	if (small.length) {
		for (const c of db
			.select({ parentId: libraryDocs.parentId, title: libraryDocs.title, author: libraryDocs.author })
			.from(libraryDocs)
			.where(and(visibleTo(userId), inArray(libraryDocs.parentId, small.map((t) => t.id))))
			.all()) {
			const key = c.parentId!;
			childTitles.set(key, [...(childTitles.get(key) ?? []), authored(c.title, c.author)]);
		}
	}

	const lines = trees.map((t) => {
		const named = childTitles.get(t.id);
		const under = (counts.get(t.id) ?? 1) - 1;
		const body = named?.length
			? named.join(' · ')
			: `${under} document${under === 1 ? '' : 's'} beneath it`;
		return `- ${authored(t.title, t.author)}: ${body}`;
	});

	const byFolder = new Map<string, string[]>();
	for (const d of loose) {
		const key = d.folder || '';
		byFolder.set(key, [...(byFolder.get(key) ?? []), authored(d.title, d.author)]);
	}
	lines.push(
		...[...byFolder.entries()]
			.sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))
			.map(([folder, titles]) => `- ${folder || 'Unfiled'}: ${titles.join(' · ')}`)
	);

	if (roots.length === maxRoots) {
		const total =
			db.get<{ n: number }>(
				sql`SELECT COUNT(*) AS n FROM library_docs
				    WHERE ${visibleTo(userId)} AND parent_id IS NULL`
			)?.n ?? roots.length;
		if (total > roots.length) lines.push(`…and ${total - roots.length} more.`);
	}
	lines.push(
		'Use library_tree to open one, library_search to search their contents, library_read to read one.'
	);
	return lines.join('\n');
}
