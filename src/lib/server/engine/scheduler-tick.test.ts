import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, runMigrations } from '$lib/server/db';
import { users } from '$lib/server/db/schema';
import { setSetting } from '$lib/server/settings';

/**
 * That one tick reaches every sweep this file defines.
 *
 * This is the test whose absence let three jobs ship dead. `sweepCortexLayout`,
 * `sweepCortexGroom` and `sweepAlignmentSynthesis` were each written, each given
 * a suite of their own, and none of them was ever called from `tick` — so every
 * one passed its own tests while never running on any install. Nothing caught
 * it: `noUnusedLocals` is off, so a sweep nobody calls type-checks perfectly,
 * and a job that never runs looks exactly like a job with nothing to do.
 *
 * Testing a sweep in isolation cannot catch this by construction. Only the
 * caller can, which is why this asserts the caller.
 *
 * Its own file because it mocks the modules the sweeps live in, and a module
 * mock is hoisted over the whole file — the same reason
 * `cortex-groom-model.test.ts` sits beside `cortex-groom.test.ts`.
 */

let failMemory = false;

const ran = {
	layout: 0,
	decay: 0,
	memory: 0,
	groom: 0,
	alignment: 0,
	uxAudit: 0
};

vi.mock('$lib/server/cortex', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/cortex')>();
	return {
		...actual,
		refreshLayout: () => {
			ran.layout++;
			return { recomputed: false, nodes: 0, edges: 0 };
		},
		decayReinforcement: () => {
			ran.decay++;
			return { days: 0, edges: 0 };
		}
	};
});

vi.mock('./memory', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./memory')>();
	return {
		...actual,
		runMemory: async () => {
			ran.memory++;
			if (failMemory) throw new Error('provider exploded');
			return { ran: true };
		}
	};
});

vi.mock('./cortex-groom', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./cortex-groom')>();
	return {
		...actual,
		runCortexGroom: async () => {
			ran.groom++;
			return { ran: true, mode: 'harvest' as const };
		}
	};
});

vi.mock('./alignment', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./alignment')>();
	return {
		...actual,
		runAlignmentSynthesis: async () => {
			ran.alignment++;
			return { ran: true };
		}
	};
});

vi.mock('./ux-audit', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./ux-audit')>();
	return {
		...actual,
		runUxAudit: async () => {
			ran.uxAudit++;
			return { ran: true };
		}
	};
});

const { tick } = await import('./scheduler');

const ANA = 'user-ana';

beforeAll(() => {
	runMigrations();
});

beforeEach(() => {
	for (const key of Object.keys(ran) as (keyof typeof ran)[]) ran[key] = 0;
	failMemory = false;
	db.delete(users).run();
	db.insert(users)
		.values({
			id: ANA,
			username: 'ana',
			isAdmin: false,
			canCode: false,
			createdAt: new Date(),
			lastSeenAt: new Date()
		})
		.run();

	// Everything on, every last run cleared, so nothing is skipped for a reason
	// unrelated to what is being asserted.
	setSetting('memory', { enabled: true, intervalHours: 0 });
	setSetting('cortexGroom', { enabled: true, intervalHours: 0, maxProposalsPerRun: 10 });
	setSetting('alignment', { enabled: true, synthesisIntervalHours: 0 });
	setSetting('uxaudit', { enabled: true, intervalHours: 0 });
	setSetting('alignment.userEnabled', true, ANA);
	setSetting('memory.userEnabled', true, ANA);
	// Reset explicitly rather than relied on: settings persist between tests in
	// one database, so a case that opts a user out would otherwise silently opt
	// them out of every case after it.
	setSetting('cortex.groom.userEnabled', true, ANA);
	setSetting('memory.lastRun', 0, ANA);
	setSetting('cortex.groom.lastRun', 0, ANA);
	setSetting('alignment.synthesis.lastRun', 0, ANA);
	setSetting('ux.lastRun', 0);
});

describe('one tick', () => {
	it('reaches every sweep, including the three that shipped uncalled', async () => {
		await tick();
		expect(ran.layout, 'the layout refresh').toBeGreaterThan(0);
		expect(ran.decay, 'the reinforcement decay').toBeGreaterThan(0);
		expect(ran.memory, 'the memory audit').toBeGreaterThan(0);
		expect(ran.groom, 'the Cortex groomer').toBeGreaterThan(0);
		expect(ran.alignment, 'the alignment letter').toBeGreaterThan(0);
		expect(ran.uxAudit, 'the UX audit').toBeGreaterThan(0);
	});

	it('honours the switch on each one', async () => {
		setSetting('cortexGroom', { enabled: false, intervalHours: 0, maxProposalsPerRun: 10 });
		setSetting('memory', { enabled: false, intervalHours: 0 });
		await tick();
		expect(ran.groom).toBe(0);
		expect(ran.memory).toBe(0);
		// The two synchronous Cortex sweeps are not gated on a feature switch:
		// both answer "has anything changed" for free and do nothing when the
		// answer is no.
		expect(ran.layout).toBeGreaterThan(0);
	});

	it('skips a user who opted their own lattice out', async () => {
		setSetting('cortex.groom.userEnabled', false, ANA);
		await tick();
		expect(ran.groom).toBe(0);
		// Somebody else's opt-out is not this user's, and the platform-level job
		// still ran for everyone who did not.
		expect(ran.memory).toBeGreaterThan(0);
	});

	it('does not let one sweep failing take the rest of the tick with it', async () => {
		failMemory = true;
		await expect(tick()).resolves.toBeUndefined();
		// One person's provider falling over is not a reason for everybody else's
		// jobs to be skipped for the rest of the day.
		expect(ran.groom).toBeGreaterThan(0);
		expect(ran.uxAudit).toBeGreaterThan(0);
	});
});
