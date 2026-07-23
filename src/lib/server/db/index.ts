import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { env } from '$env/dynamic/private';
import * as schema from './schema';

export const dataDir = env.DATA_DIR || './data';
mkdirSync(dataDir, { recursive: true });

const sqlite = new Database(join(dataDir, 'galaxy.db'));
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');

export const db = drizzle(sqlite, { schema });

// Migrations ship with the image and run on every boot; they must stay
// forward-compatible so a prod rollback never meets a broken schema.
export function runMigrations() {
	migrate(db, { migrationsFolder: 'drizzle' });
	// FTS5 virtual tables sit outside drizzle's schema management.
	sqlite.exec(
		`CREATE VIRTUAL TABLE IF NOT EXISTS library_fts USING fts5(id UNINDEXED, title, body)`
	);
}
