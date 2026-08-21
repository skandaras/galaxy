import { describe, expect, it } from 'vitest';
import {
	DEFAULT_WEB_SEARCH,
	WEB_SEARCH_SETTINGS_VERSION,
	migrateWebSearchSettings,
	normaliseWebSearchSettings
} from './settings';

describe('migrateWebSearchSettings', () => {
	it('raises values that are only the old defaults', () => {
		// The gap this closes: a stored row beats the default on every read, so
		// widening the search net reached only installs that had never pressed
		// Save — which, after one visit to the admin panel, is none of them.
		const out = migrateWebSearchSettings({ provider: 'brave', maxResults: 5, maxSearchesPerTurn: 4 });
		expect(out).toMatchObject({ maxResults: 20, maxSearchesPerTurn: 6 });
	});

	it('leaves a number someone actually chose', () => {
		const out = migrateWebSearchSettings({ provider: 'brave', maxResults: 12, maxSearchesPerTurn: 4 });
		expect(out).toMatchObject({ maxResults: 12, maxSearchesPerTurn: 6 });
	});

	it('runs once, so a later choice of the old value survives the next boot', () => {
		const first = migrateWebSearchSettings({ provider: 'brave', maxResults: 5 });
		expect(first?.settingsVersion).toBe(WEB_SEARCH_SETTINGS_VERSION);
		// An admin who now deliberately wants five keeps five.
		expect(migrateWebSearchSettings({ ...first!, maxResults: 5 })).toBeNull();
	});

	it('does nothing when there is no row, since the defaults already apply', () => {
		expect(migrateWebSearchSettings(null)).toBeNull();
		expect(migrateWebSearchSettings({})).toBeNull();
	});

	it('fills fields the stored row never had', () => {
		// `maxResults: undefined` was not harmless: parseDuckDuckGoHtml stops at
		// `results.length < max`, which is false immediately, so it returned none.
		const out = migrateWebSearchSettings({ provider: 'duckduckgo' });
		expect(out?.maxResults).toBe(DEFAULT_WEB_SEARCH.maxResults);
		expect(out?.timeoutMs).toBe(DEFAULT_WEB_SEARCH.timeoutMs);
	});

	it('keeps the provider and its secret', () => {
		const out = migrateWebSearchSettings({ provider: 'brave', apiKeyEnc: 'enc', maxResults: 5 });
		expect(out).toMatchObject({ provider: 'brave', apiKeyEnc: 'enc' });
	});
});

describe('normaliseWebSearchSettings', () => {
	it('clamps what the form only claims to constrain', () => {
		// A raw PUT ignores the form's min/max entirely.
		expect(normaliseWebSearchSettings({ maxResults: 500 }).maxResults).toBe(20);
		expect(normaliseWebSearchSettings({ maxResults: 0 }).maxResults).toBe(1);
		expect(normaliseWebSearchSettings({ maxSearchesPerTurn: -3 }).maxSearchesPerTurn).toBe(1);
		expect(normaliseWebSearchSettings({ timeoutMs: 10 }).timeoutMs).toBe(1_000);
	});

	it('carries the encrypted key through, since it also passes SECRET_FIELDS', () => {
		expect(normaliseWebSearchSettings({ apiKeyEnc: 'enc' })).toMatchObject({ apiKeyEnc: 'enc' });
	});

	it('stamps the version, so saving is itself the migration', () => {
		expect(normaliseWebSearchSettings({}).settingsVersion).toBe(WEB_SEARCH_SETTINGS_VERSION);
	});

	it('falls back rather than storing NaN', () => {
		expect(normaliseWebSearchSettings({ maxResults: 'lots' }).maxResults).toBe(
			DEFAULT_WEB_SEARCH.maxResults
		);
	});
});
