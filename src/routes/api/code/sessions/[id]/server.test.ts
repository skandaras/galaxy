import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { db, runMigrations } from '$lib/server/db';
import { codeSessions, models, providers } from '$lib/server/db/schema';
import { createChat } from '$lib/server/chats';
import { getOrchestrateModels } from '$lib/server/engine/coding/session';
import { PATCH } from './+server';

const USER = { id: 'coder-1', username: 'coder', email: null, displayName: null, isAdmin: false, canCode: true };

beforeAll(() => {
	runMigrations();
	db.insert(providers)
		.values({
			id: 'p-route',
			name: 'p-route',
			kind: 'openai-compatible',
			baseUrl: 'http://example.invalid/v1',
			apiKeyEnc: null,
			enabled: true,
			createdAt: new Date()
		})
		.run();
	for (const [id, supportsTools] of [['route-tools', true], ['route-plain', false]] as const) {
		db.insert(models)
			.values({
				id,
				providerId: 'p-route',
				modelKey: id,
				displayName: id,
				contextWindow: 8000,
				supportsTools,
				supportsVision: false,
				promptCostPerMTok: null,
				completionCostPerMTok: null,
				cacheMode: 'auto',
				enabled: true
			})
			.run();
	}
});

function session() {
	const chat = createChat({ userId: USER.id, mode: 'code', title: 'r' });
	db.insert(codeSessions)
		.values({
			chatId: chat.id,
			userId: USER.id,
			repoUrl: 'https://github.com/o/r.git',
			repoName: 'r',
			baseBranch: 'main',
			workBranch: `galaxy/${randomUUID()}`,
			workspaceRel: `workspaces/${chat.id}`,
			mode: 'plan',
			prUrl: null,
			createdAt: new Date()
		})
		.run();
	return chat.id;
}

async function patch(id: string, body: unknown) {
	try {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const res = (await PATCH({ locals: { user: USER }, params: { id }, request: new Request('http://x', { method: 'PATCH', body: JSON.stringify(body) }) } as any)) as Response;
		return { status: res.status, body: await res.json() };
	} catch (err) {
		return { status: (err as { status?: number }).status, body: null };
	}
}

describe('PATCH a code session', () => {
	it('switches to orchestrate and stores the tier models', async () => {
		const id = session();
		const res = await patch(id, { mode: 'orchestrate', tierModels: { tier2: 'route-tools' } });
		expect(res.status).toBe(200);
		expect(res.body.mode).toBe('orchestrate');
		expect(getOrchestrateModels(id)).toEqual({ tier2: 'route-tools' });
		await patch(id, { tierModels: { tier2: null } });
		expect(getOrchestrateModels(id)).toEqual({});
	});

	it('answers 400 for an unknown or tool-less model and changes nothing', async () => {
		const id = session();
		expect((await patch(id, { mode: 'orchestrate', tierModels: { tier1: 'no-such-model' } })).status).toBe(400);
		expect((await patch(id, { tierModels: { tier1: 'route-plain' } })).status).toBe(400);
		expect((await patch(id, { tierModels: 'route-tools' })).status).toBe(400);
		const after = await patch(id, {});
		expect(after.body.mode).toBe('plan');
		expect(getOrchestrateModels(id)).toEqual({});
	});

	it('answers 404 for a session that is not yours', async () => {
		const id = session();
		expect((await patch(id.replace(/.$/, 'x'), { mode: 'implement' })).status).toBe(404);
	});
});
