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
}): LibraryDoc {
	mkdirSync(libraryDir(), { recursive: true });
	const now = new Date();
	const existing = opts.id
		? db.select().from(libraryDocs).where(eq(libraryDocs.id, opts.id)).get()
		: null;
	const id = existing?.id ?? uniqueSlug(slugify(opts.title));
	const snippet = makeSnippet(opts.body);

	writeFileSync(join(libraryDir(), `${id}.md`), opts.body);

	const row: LibraryDoc = {
		id,
		title: opts.title.trim() || id,
		snippet,
		author: existing?.author ?? opts.author,
		ownerId: existing ? existing.ownerId : opts.ownerId,
		visibility: existing ? existing.visibility : (opts.visibility ?? 'personal'),
		sizeBytes: Buffer.byteLength(opts.body),
		createdAt: existing?.createdAt ?? now,
		updatedAt: now
	};
	if (existing) {
		db.update(libraryDocs)
			.set({ title: row.title, snippet, sizeBytes: row.sizeBytes, updatedAt: now })
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

/** Quote terms so user input can't break FTS5 query syntax. */
function ftsQuery(q: string): string {
	return q
		.split(/\s+/)
		.filter(Boolean)
		.slice(0, 8)
		.map((t) => `"${t.replace(/"/g, '')}"`)
		.join(' ');
}

function uniqueSlug(base: string): string {
	let candidate = base;
	for (let i = 2; db.select().from(libraryDocs).where(eq(libraryDocs.id, candidate)).get(); i++) {
		candidate = `${base}-${i}`;
	}
	return candidate;
}

/** Compact digest of the whole Library for the agent context bootstrap. */
export function libraryDigest(userId: string, maxDocs = 30): string {
	const docs = listDocs(userId);
	if (!docs.length) return '(library is empty)';
	const lines = docs
		.slice(0, maxDocs)
		.map((d) => `- ${d.title}${d.author === 'agent' ? ' [agent]' : ''}: ${d.snippet.slice(0, 120)}`);
	if (docs.length > maxDocs) {
		lines.push(`…and ${docs.length - maxDocs} more — use library_search to find them.`);
	}
	return lines.join('\n');
}
