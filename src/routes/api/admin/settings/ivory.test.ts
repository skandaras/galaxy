import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, runMigrations } from '$lib/server/db';
import { settings as settingsTable } from '$lib/server/db/schema';
import { decryptSecret } from '$lib/server/crypto';
import { getSetting, ivorySettings } from '$lib/server/settings';
import { GET, PUT } from './+server';

/** The research API keys: stored encrypted, kept when the form sends blank, never served back. */

beforeAll(() => {
	runMigrations();
});

beforeEach(() => {
	db.delete(settingsTable).run();
});

const locals = { user: { id: 'admin', isAdmin: true } };
const put = (value: unknown) =>
	PUT({
		locals,
		request: new Request('http://x/api/admin/settings', { method: 'PUT', body: JSON.stringify({ key: 'ivory', value }) })
	} as never);
const get = async () => (await (await GET({ locals } as never)).json()).ivory;

describe('the Shelf API keys', () => {
	it('are stored encrypted and never served back', async () => {
		await put({ shelfRepo: 'me/shelf', coreApiKey: 'core-secret', semanticScholarApiKey: 's2-secret' });
		const stored = getSetting<Record<string, string>>('ivory', {});
		expect(stored.coreApiKey).toBeUndefined();
		expect(decryptSecret(stored.coreApiKeyEnc)).toBe('core-secret');
		expect(decryptSecret(stored.semanticScholarApiKeyEnc)).toBe('s2-secret');

		const served = await get();
		expect(JSON.stringify(served)).not.toMatch(/secret|Enc/);
		expect(served).toMatchObject({ shelfRepo: 'me/shelf', hasCoreApiKey: true, hasSemanticScholarApiKey: true });
	});

	it('are kept when the form sends them blank, and cleared by null', async () => {
		await put({ coreApiKey: 'core-secret', semanticScholarApiKey: 's2-secret' });
		await put({ coreApiKey: '', semanticScholarApiKey: null, paperProvider: 'semanticscholar' });
		const cfg = ivorySettings();
		expect(decryptSecret(cfg.coreApiKeyEnc!)).toBe('core-secret');
		expect(cfg.semanticScholarApiKeyEnc).toBeUndefined();
		expect(cfg.paperProvider).toBe('semanticscholar');
	});
});
