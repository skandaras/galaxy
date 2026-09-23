import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, runMigrations } from '$lib/server/db';
import { models, providers } from '$lib/server/db/schema';
import { adapterFor, listEnabledModels, resolveModel } from './registry';

/**
 * A provider kept to coding.
 *
 * Hiding its models from the chat dropdown would not have been enough on its
 * own: the chat route resolves whatever model id the browser sends, and
 * pickModel falls back to the first enabled model with nobody choosing it. So
 * these assert on resolution, which is where the flag has to hold.
 */

beforeAll(() => runMigrations());

function provider(id: string, codingOnly: boolean, kind: 'openai' | 'openrouter' = 'openrouter') {
	db.insert(providers)
		.values({
			id,
			name: id,
			kind,
			baseUrl: 'http://127.0.0.1:1/v1',
			apiKeyEnc: null,
			enabled: true,
			codingOnly,
			createdAt: new Date()
		})
		.run();
	db.insert(models)
		.values({
			id: `m-${id}`,
			providerId: id,
			modelKey: `${id}-model`,
			// Sorted first, so a fallback that ignored the flag would land on it.
			displayName: codingOnly ? 'A coding model' : 'B general model',
			contextWindow: 8000,
			supportsTools: true,
			supportsVision: true,
			promptCostPerMTok: null,
			completionCostPerMTok: null,
			cacheMode: 'auto',
			enabled: true
		})
		.run();
}

beforeEach(() => {
	db.delete(models).run();
	db.delete(providers).run();
	provider('gpt', true, 'openai');
	provider('general', false);
});

describe('coding-only providers', () => {
	it('resolve for coding and the explore sub-agent', () => {
		expect(resolveModel('m-gpt', 'coding')?.model.modelKey).toBe('gpt-model');
		expect(resolveModel('m-gpt', 'subagent')?.model.modelKey).toBe('gpt-model');
	});

	it('do not resolve for chat, other tasks, or a caller that names no task', () => {
		expect(resolveModel('m-gpt', 'chat')).toBeNull();
		expect(resolveModel('m-gpt', 'memory')).toBeNull();
		expect(resolveModel('m-gpt')).toBeNull();
	});

	it('are left out of every listing but coding', () => {
		expect(listEnabledModels('chat').map((m) => m.id)).toEqual(['m-general']);
		expect(listEnabledModels().map((m) => m.id)).toEqual(['m-general']);
		expect(listEnabledModels('coding').map((m) => m.id)).toEqual(['m-gpt', 'm-general']);
	});

	it('leave every other provider as it was', () => {
		expect(resolveModel('m-general', 'chat')?.model.modelKey).toBe('general-model');
		expect(resolveModel('m-general')?.model.modelKey).toBe('general-model');
		expect(resolveModel('m-general', 'coding')?.model.modelKey).toBe('general-model');
	});
});

describe('adapterFor', () => {
	it('gives an openai provider the Responses adapter and the rest the compat one', async () => {
		const seen: string[] = [];
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (url: string) => {
			seen.push(url);
			return new Response('no', { status: 500 });
		}) as typeof fetch;
		try {
			const rows = db.select().from(providers).all();
			for (const row of rows) {
				await adapterFor(row)
					.complete({ modelKey: 'x', messages: [{ role: 'user', content: 'hi' }] })
					.catch(() => {});
			}
		} finally {
			globalThis.fetch = realFetch;
		}
		expect(seen.sort()).toEqual([
			'http://127.0.0.1:1/v1/chat/completions',
			'http://127.0.0.1:1/v1/responses'
		]);
	});
});
