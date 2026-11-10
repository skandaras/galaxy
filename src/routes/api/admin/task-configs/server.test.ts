import { beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '$lib/server/db';
import { seedTaskConfigs } from '$lib/server/bootstrap';
import { DEFAULT_TASK_DESCRIPTIONS } from '$lib/server/engine/engine';
import { GET, PUT } from './+server';

const ADMIN = { id: 'admin-1', username: 'admin', email: null, displayName: null, isAdmin: true, canCode: true };

beforeAll(() => {
	runMigrations();
	seedTaskConfigs();
});

const put = (body: unknown) =>
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	PUT({ locals: { user: ADMIN }, request: new Request('http://x', { method: 'PUT', body: JSON.stringify(body) }) } as any);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const list = async () => (await (GET({ locals: { user: ADMIN } } as any) as Response).json()) as Record<string, unknown>[];

describe('task-configs route and the worker tier descriptions', () => {
	it('lists the default description for the two tiers only', async () => {
		const rows = await list();
		const t2 = rows.find((r) => r.task === 'coding-tier2');
		expect(t2).toMatchObject({
			description: DEFAULT_TASK_DESCRIPTIONS['coding-tier2'],
			defaultDescription: DEFAULT_TASK_DESCRIPTIONS['coding-tier2']
		});
		expect(rows.find((r) => r.task === 'chat')).not.toHaveProperty('defaultDescription');
	});

	it('saves a custom description, and drops one equal to the default', async () => {
		await put({ task: 'coding-tier1', options: { description: '  Only touches docs.  ' } });
		expect((await list()).find((r) => r.task === 'coding-tier1')).toMatchObject({
			description: 'Only touches docs.',
			defaultDescription: DEFAULT_TASK_DESCRIPTIONS['coding-tier1']
		});
		await put({ task: 'coding-tier1', options: { description: DEFAULT_TASK_DESCRIPTIONS['coding-tier1'] } });
		const row = (await list()).find((r) => r.task === 'coding-tier1');
		expect(row?.options).toBeNull();
		expect(row?.description).toBe(DEFAULT_TASK_DESCRIPTIONS['coding-tier1']);
	});
});
