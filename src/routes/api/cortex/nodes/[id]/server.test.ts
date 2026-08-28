import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, runMigrations } from '$lib/server/db';
import { cortexAssociations, cortexCircuits, cortexNodes } from '$lib/server/db/schema';
import { getNode, saveCircuit, saveNode } from '$lib/server/cortex';
import { PATCH } from './+server';

/**
 * Editing a concept used to change only its visibility.
 *
 * The handler checked `visibility` and returned early, and the editor always
 * sends it — a checkbox is never absent — so the name, description, areas and
 * bridge flag were dropped on every edit. Each of those fields had been tested
 * on its own and passed; none had ever been sent *together*, which is the only
 * arrangement that shows it.
 */

const USER = {
	id: 'user-ana',
	username: 'ana',
	email: null,
	displayName: null,
	isAdmin: false
};

beforeAll(() => {
	runMigrations();
});

beforeEach(() => {
	db.delete(cortexAssociations).run();
	db.delete(cortexNodes).run();
	db.delete(cortexCircuits).run();
	db.run(`DELETE FROM cortex_fts`);
});

function patch(id: string, body: unknown, user: unknown = USER) {
	return PATCH({
		locals: { user },
		params: { id },
		request: new Request('http://localhost/', { method: 'PATCH', body: JSON.stringify(body) })
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
	} as any);
}

describe('editing a concept', () => {
	it('saves every field sent in one go', async () => {
		const area = saveCircuit({ name: 'Coastal fieldwork', ownerId: USER.id });
		const node = saveNode({ name: 'Tide pools', description: 'first', ownerId: USER.id });

		const res = await patch(node.id, {
			name: 'Rockpools',
			description: 'rewritten',
			circuits: [area.id],
			isConvergence: true,
			// The field that used to end the request before any of the others
			// were looked at.
			visibility: 'shared'
		});
		expect(res.status).toBe(200);

		const after = getNode(node.id, USER.id)!;
		expect(after.name).toBe('Rockpools');
		expect(after.description).toBe('rewritten');
		expect(after.circuits).toEqual([area.id]);
		expect(after.isConvergence).toBe(true);
		expect(after.visibility).toBe('shared');
	});

	it('still changes visibility on its own', async () => {
		const node = saveNode({ name: 'Tide pools', ownerId: USER.id });
		await patch(node.id, { visibility: 'shared' });
		expect(getNode(node.id, USER.id)!.visibility).toBe('shared');
	});

	it('leaves a field alone when it is not sent', async () => {
		const node = saveNode({ name: 'Tide pools', description: 'keep me', ownerId: USER.id });
		await patch(node.id, { name: 'Rockpools' });
		const after = getNode(node.id, USER.id)!;
		expect(after.name).toBe('Rockpools');
		expect(after.description).toBe('keep me');
	});

	it('refuses to change a concept that is not yours', async () => {
		const node = saveNode({ name: 'Tide pools', ownerId: 'user-ben', visibility: 'shared' });
		// Readable, not editable — and the refusal has to come before anything
		// is written, not after visibility has already moved.
		await expect(patch(node.id, { name: 'Claimed', visibility: 'personal' })).rejects.toThrow();
		expect(getNode(node.id, 'user-ben')!.name).toBe('Tide pools');
	});
});
