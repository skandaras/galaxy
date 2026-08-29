import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, runMigrations } from '$lib/server/db';
import { settings as settingsTable } from '$lib/server/db/schema';
import {
	DEFAULT_CORTEX,
	DEFAULT_CORTEX_GROOM,
	DEFAULT_RETENTION,
	getSetting,
	setSetting
} from '$lib/server/settings';

/**
 * The gap this phase opened with: the groomer had a schedule and no way to
 * reach it. `cortex` and `cortexGroom` were never registered with the admin
 * settings API, so the only way to enable anything was to write to this table
 * by hand.
 */

beforeAll(() => {
	runMigrations();
});

beforeEach(() => {
	db.delete(settingsTable).run();
});

describe('the admin settings API', () => {
	it('knows about every Cortex key', async () => {
		const source = await import('node:fs').then((fs) =>
			fs.readFileSync('src/routes/api/admin/settings/+server.ts', 'utf8')
		);
		// A settings object with no key here is unreachable: the handler rejects
		// anything it has not been told about.
		expect(source).toContain("'cortex'");
		expect(source).toContain("'cortexGroom'");
		expect(source).toContain('DEFAULT_CORTEX');
		expect(source).toContain('DEFAULT_CORTEX_GROOM');
	});

	it('round-trips the groom schedule', () => {
		setSetting('cortexGroom', { ...DEFAULT_CORTEX_GROOM, enabled: true, intervalHours: 24 });
		const stored = { ...DEFAULT_CORTEX_GROOM, ...getSetting('cortexGroom', {}) };
		expect(stored.enabled).toBe(true);
		expect(stored.intervalHours).toBe(24);
		expect(stored.maxProposalsPerRun).toBe(DEFAULT_CORTEX_GROOM.maxProposalsPerRun);
	});

	it('keeps the change-history window a row written before it existed did not have', () => {
		// The retention form hand-lists its fields, so a new one only survives
		// because `fill` spreads the defaults before the stored value.
		setSetting('retention', { eventDays: 30, usageDays: 100, uxIdeaDays: 7 });
		const filled = { ...DEFAULT_RETENTION, ...getSetting<object>('retention', {}) };
		expect(filled.cortexChangeDays).toBe(DEFAULT_RETENTION.cortexChangeDays);
		expect(filled.eventDays).toBe(30);
	});

	it('ships agent writes on and the scheduled groomer off', () => {
		// Writes waited on the groomer and it exists now. The scheduled pass is a
		// different question: it spends tokens unasked, so it stays opt-in.
		expect(DEFAULT_CORTEX.agentWrites).toBe(true);
		expect(DEFAULT_CORTEX_GROOM.enabled).toBe(false);
	});
});
