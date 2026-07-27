import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { dataDir } from './index';

/**
 * Guards the test harness itself. If DATA_DIR ever stops being set per worker
 * (src/test-setup.ts), parallel suites go back to sharing one SQLite file and
 * the suite fails intermittently with SQLITE_BUSY — which is exactly how this
 * was missed locally and caught in CI.
 */
describe('test database isolation', () => {
	it('resolves DATA_DIR to a per-worker directory', () => {
		expect(process.env.DATA_DIR).toBeTruthy();
		expect(process.env.DATA_DIR).not.toBe('./data');
		// The worker id is part of the path, so no two workers can collide.
		expect(dataDir.startsWith(tmpdir())).toBe(true);
		expect(dataDir).toMatch(/galaxy-test-/);
	});

	it('opened the database inside that directory', () => {
		// dataDir is read once at import; proves setup ran before db/index.ts.
		expect(dataDir).toBe(process.env.DATA_DIR);
	});
});
