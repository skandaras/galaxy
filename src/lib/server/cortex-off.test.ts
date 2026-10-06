import { beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '$lib/server/db';
import { cortexEnabled } from '$lib/features';
import { saveNode } from './cortex';
import { bootstrapContext } from './engine/tools/knowledge';
import { builtinDescriptors } from './engine/tools/registry';
import { localContext } from './engine/research';

/**
 * Cortex is switched off and kept. These hold down the first half: with a
 * lattice that has something in it, nothing of it reaches an agent. The second
 * half, that its data is left alone, is in cortex-groom.test.ts and
 * scheduler-tick.test.ts.
 */

const USER = 'user-cortex-off';

beforeAll(() => {
	runMigrations();
	saveNode({ name: 'Tidal ecology', description: 'how the coast works', ownerId: USER });
});

describe('Cortex while switched off', () => {
	it('is off', () => {
		expect(cortexEnabled()).toBe(false);
	});

	it('puts nothing in the context bootstrap', () => {
		const text = bootstrapContext(USER);
		expect(text).not.toMatch(/cortex/i);
		expect(text).not.toContain('Tidal ecology');
	});

	it('offers no tools, in a turn or in the Admin catalogue', () => {
		const names = builtinDescriptors().map((d) => d.name);
		expect(names).not.toContain('cortex_query');
		expect(names).not.toContain('cortex_write');
	});

	it('gives research nothing to aim with', () => {
		expect(localContext(USER, 'tidal ecology')).not.toContain('Concept');
	});
});
