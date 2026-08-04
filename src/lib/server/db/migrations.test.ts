import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
import { is } from 'drizzle-orm';
import { getTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core';
import * as schema from './schema';

/**
 * Guards the seam where two branches both add a migration.
 *
 * Drizzle applies exactly what `_journal.json` lists — never whatever `.sql`
 * files happen to be on disk. So when two branches each generate `0011_*` and
 * git resolves the journal by taking one side, the loser's migration is still
 * committed, still reviewed, and still completely inert. The columns are never
 * created, and the failure only shows up at runtime as `no such column`.
 *
 * That is exactly what happened merging the MCP-env branch with this one. These
 * tests fail on the pull request instead.
 */
const DIR = 'drizzle';

interface Journal {
	entries: { idx: number; tag: string }[];
}

const journal = (): Journal => JSON.parse(readFileSync(`${DIR}/meta/_journal.json`, 'utf8'));

describe('migration journal', () => {
	it('lists every migration file on disk', () => {
		const onDisk = readdirSync(DIR)
			.filter((f) => f.endsWith('.sql'))
			.sort();
		const listed = new Set(journal().entries.map((e) => `${e.tag}.sql`));
		const orphans = onDisk.filter((f) => !listed.has(f));

		expect(
			orphans,
			`These migrations exist but will never run — regenerate them on top of the current journal:\n  ${orphans.join('\n  ')}`
		).toEqual([]);
	});

	it('has no duplicate indexes or tags', () => {
		const entries = journal().entries;
		expect(new Set(entries.map((e) => e.idx)).size).toBe(entries.length);
		expect(new Set(entries.map((e) => e.tag)).size).toBe(entries.length);
	});

	it('numbers its files in the order the journal applies them', () => {
		const tags = journal().entries.map((e) => e.tag);
		expect([...tags].sort()).toEqual(tags);
	});
});

describe('migrations produce the schema the code expects', () => {
	/** Apply the journal, in order, to a throwaway in-memory database. */
	function migratedColumns(): Map<string, Set<string>> {
		const db = new Database(':memory:');
		for (const entry of journal().entries) {
			for (const stmt of readFileSync(`${DIR}/${entry.tag}.sql`, 'utf8').split(
				'--> statement-breakpoint'
			)) {
				if (stmt.trim()) db.exec(stmt);
			}
		}
		const out = new Map<string, Set<string>>();
		const tables = db
			.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
			.all() as { name: string }[];
		for (const t of tables) {
			const cols = db.prepare(`PRAGMA table_info('${t.name}')`).all() as { name: string }[];
			out.set(
				t.name,
				new Set(cols.map((c) => c.name))
			);
		}
		db.close();
		return out;
	}

	it('creates every table and column the drizzle schema declares', () => {
		const migrated = migratedColumns();
		const missing: string[] = [];

		// The module also exports consts and interfaces; `is` is drizzle's own
		// discriminator, and using anything looser here silently checks nothing —
		// which is exactly how the first draft of this test passed while looking
		// at zero tables.
		const tables = Object.values(schema).filter((v) => is(v, SQLiteTable));
		expect(
			tables.length,
			'no tables detected — this assertion would pass vacuously'
		).toBeGreaterThan(10);

		for (const table of tables) {
			const config = getTableConfig(table as SQLiteTable);
			const columns = migrated.get(config.name);
			if (!columns) {
				missing.push(`table ${config.name} is never created`);
				continue;
			}
			for (const col of config.columns) {
				if (!columns.has(col.name)) missing.push(`${config.name}.${col.name}`);
			}
		}

		expect(
			missing,
			`The schema declares these but no migration creates them — run \`npm run db:generate\`:\n  ${missing.join('\n  ')}`
		).toEqual([]);
	});
});
