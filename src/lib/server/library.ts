import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { and, desc, eq, isNull, or, sql, type SQL } from 'drizzle-orm';
import { db, dataDir } from '$lib/server/db';
import { libraryDocs } from '$lib/server/db/schema';

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

	const row: LibraryDoc = {
		id,
		title: opts.title.trim() || id,
		snippet,
		author: existing?.author ?? opts.author,
		ownerId: existing ? existing.ownerId : opts.ownerId,
		visibility: existing ? existing.visibility : (opts.visibility ?? 'personal'),
		folder,
		sizeBytes: Buffer.byteLength(opts.body),
		createdAt: existing?.createdAt ?? now,
		updatedAt: now
	};
	if (existing) {
		db.update(libraryDocs)
			.set({ title: row.title, snippet, folder, sizeBytes: row.sizeBytes, updatedAt: now })
			.where(eq(libraryDocs.id, id))
			.run();
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
	db.delete(libraryDocs).where(eq(libraryDocs.id, id)).run();
	db.run(sql`DELETE FROM library_fts WHERE id = ${id}`);
	rmSync(join(libraryDir(), `${id}.md`), { force: true });
	return true;
}

export function searchDocs(
	query: string,
	userId: string,
	limit = 20
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
export function libraryDigest(userId: string, maxDocs = 40): string {
	const docs = listDocs(userId);
	if (!docs.length) return '(library is empty)';

	// Grouped, because a folder is a strong hint about what a doc is for and
	// costs a line per group rather than a line per doc.
	const byFolder = new Map<string, string[]>();
	for (const d of docs.slice(0, maxDocs)) {
		const key = d.folder || '';
		const label = `${d.title}${d.author === 'agent' ? ' [agent]' : ''}`;
		byFolder.set(key, [...(byFolder.get(key) ?? []), label]);
	}

	const lines = [...byFolder.entries()]
		.sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))
		.map(([folder, titles]) => `- ${folder || 'Unfiled'}: ${titles.join(' · ')}`);

	if (docs.length > maxDocs) lines.push(`…and ${docs.length - maxDocs} more.`);
	lines.push('Use library_search to search their contents, library_read to open one.');
	return lines.join('\n');
}
