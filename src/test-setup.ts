import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Give every vitest worker its own DATA_DIR, and therefore its own SQLite file.
 *
 * Test files run in parallel and several of them open the database at import
 * time (anything reaching $lib/server/db, directly or via crypto.ts). Pointing
 * them all at one file has two failure modes:
 *
 *  - `journal_mode = WAL` needs an exclusive lock, and SQLite does not honour
 *    busy_timeout for a journal-mode switch. A worker that opens the file while
 *    another is mid-migration fails instantly with SQLITE_BUSY, taking the run
 *    with it. That is timing-dependent, so it passed locally and broke in CI.
 *  - Suites that write the same tables (tool_settings, mcp_servers) could see
 *    each other's rows.
 *
 * Keyed by worker rather than randomised so repeated local runs reuse a bounded
 * set of directories, and wiped up front so no run inherits stale state.
 *
 * Runs before the test module is imported, which is what makes it effective —
 * db/index.ts reads DATA_DIR once, at import.
 */
const workerId = process.env.VITEST_WORKER_ID ?? process.env.VITEST_POOL_ID ?? String(process.pid);
const dir = join(tmpdir(), `galaxy-test-${workerId}`);

rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
process.env.DATA_DIR = dir;
