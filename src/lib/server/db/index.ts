import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { env } from '$env/dynamic/private';
import * as schema from './schema';

// `$env/dynamic/private` is the normal source and is what production uses.
// process.env is a fallback for tests: SvelteKit snapshots the dynamic env when
// Vite loads its config, so it cannot vary per vitest worker — but each worker
// needs its own directory to avoid sharing one SQLite file. See src/test-setup.ts.
export const dataDir = env.DATA_DIR || process.env.DATA_DIR || './data';
mkdirSync(dataDir, { recursive: true });

const sqlite = new Database(join(dataDir, 'galaxy.db'));

// WAL is a persistent property of the file, so this only has to succeed once.
// Switching it needs an exclusive lock, and SQLite does *not* apply
// busy_timeout to a journal-mode change — so if another connection is mid-write
// this fails instantly. Losing that race must not take the process down when
// the database is almost certainly already in WAL.
try {
	sqlite.pragma('journal_mode = WAL');
} catch (err) {
	const mode = String(sqlite.pragma('journal_mode', { simple: true }) ?? '').toLowerCase();
	if (mode !== 'wal') {
		console.warn(
			`[db] could not switch to WAL (${err instanceof Error ? err.message : err}); running in "${mode}" mode`
		);
	}
}
sqlite.pragma('foreign_keys = ON');
// A lock we lose must wait, not fail. Nothing here retries a SQLITE_BUSY, and
// the app is not the only writer: the end-to-end smoke suite opens its own
// connection against the live database while the server is serving it.
sqlite.pragma('busy_timeout = 5000');
// FULL is SQLite's default and it fsyncs on every commit. In WAL, NORMAL is
// still durable across a process crash — only an OS or power failure can lose
// the tail — and this database commits constantly: emitEvent writes a row for
// every model call, every tool call, every failover, so one ten-tool turn was
// ten-plus fsyncs on the thread serving the request.
sqlite.pragma('synchronous = NORMAL');

export const db = drizzle(sqlite, { schema });

// Migrations ship with the image and run on every boot; they must stay
// forward-compatible so a prod rollback never meets a broken schema.
export function runMigrations() {
	migrate(db, { migrationsFolder: 'drizzle' });
	// FTS5 virtual tables sit outside drizzle's schema management.
	sqlite.exec(
		`CREATE VIRTUAL TABLE IF NOT EXISTS library_fts USING fts5(id UNINDEXED, title, body)`
	);
	// Cortex seeds its traversals from here rather than from a hand-maintained
	// keyword map: a map has to be written by someone, and when its coverage
	// falls behind the lattice the failure is silent — queries stop reaching the
	// right region and nothing says so.
	sqlite.exec(
		`CREATE VIRTUAL TABLE IF NOT EXISTS cortex_fts USING fts5(id UNINDEXED, name, description)`
	);
}
