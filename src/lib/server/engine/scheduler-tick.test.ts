import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, runMigrations } from '$lib/server/db';
import { users } from '$lib/server/db/schema';
import { setSetting } from '$lib/server/settings';

/**
 * That one tick reaches every sweep this file defines.
 *
 * This is the test whose absence let jobs ship dead. `sweepAlignmentSynthesis`
 * among them was written, given a suite of its own, and never called from
 * `tick` — so it passed its own tests while never running on any install.
 * Nothing caught it: `noUnusedLocals` is off, so a sweep nobody calls
 * type-checks perfectly, and a job that never runs looks exactly like a job
 * with nothing to do.
 *
 * Testing a sweep in isolation cannot catch this by construction. Only the
 * caller can, which is why this asserts the caller.
 *
 * Its own file because it mocks the modules the sweeps live in, and a module
 * mock is hoisted over the whole file.
 */

let failMemory = false;

const ran = {
	memory: 0,
	alignment: 0,
	uxAudit: 0,
	skills: 0
};

vi.mock('./memory', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./memory')>();
	return {
		...actual,
		runMemory: async () => {
			ran.memory++;
			if (failMemory) throw new Error('provider exploded');
			return { ran: true };
		},
		runSkillOptimiser: async () => {
			ran.skills++;
			return { ran: true };
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
	setSetting('alignment', { enabled: true, synthesisIntervalHours: 0 });
	setSetting('uxaudit', { enabled: true, intervalHours: 0 });
	setSetting('alignment.userEnabled', true, ANA);
	setSetting('memory.userEnabled', true, ANA);
	// Reset explicitly rather than relied on: settings persist between tests in
	// one database, so a case that opts a user out would otherwise silently opt
	// them out of every case after it.
	setSetting('memory.lastRun', 0, ANA);
	setSetting('alignment.synthesis.lastRun', 0, ANA);
	setSetting('ux.lastRun', 0);
	// The one agent that ships off. Every case here is about whether tick reaches
	// a sweep, so it is switched on explicitly rather than left at its default.
	setSetting('skillOptimiser', { enabled: true, intervalHours: 0 });
	setSetting('skills.lastRun', 0);
});

describe('one tick', () => {
	it('reaches every sweep, including the one that shipped uncalled', async () => {
		await tick();
		expect(ran.memory, 'the memory audit').toBeGreaterThan(0);
		expect(ran.alignment, 'the alignment letter').toBeGreaterThan(0);
		expect(ran.uxAudit, 'the UX audit').toBeGreaterThan(0);
		expect(ran.skills, 'the skill optimiser').toBeGreaterThan(0);
	});

	it('leaves the skill optimiser alone while it is off', async () => {
		// Its default, and the reason it needs its own case: every other sweep in
		// this file ships enabled, so "off" is not otherwise exercised here.
		setSetting('skillOptimiser', { enabled: false, intervalHours: 0 });
		await tick();
		expect(ran.skills).toBe(0);
		expect(ran.uxAudit).toBeGreaterThan(0);
	});

	it('honours the switch on each one', async () => {
		setSetting('memory', { enabled: false, intervalHours: 0 });
		await tick();
		expect(ran.memory).toBe(0);
		expect(ran.uxAudit).toBeGreaterThan(0);
	});

	it('skips a user who opted their own memory out', async () => {
		setSetting('memory.userEnabled', false, ANA);
		await tick();
		expect(ran.memory).toBe(0);
		// Their opt-out is about their memory, not about the jobs that run for
		// everybody.
		expect(ran.alignment).toBeGreaterThan(0);
	});

	it('does not let one sweep failing take the rest of the tick with it', async () => {
		failMemory = true;
		await expect(tick()).resolves.toBeUndefined();
		// One person's provider falling over is not a reason for everybody else's
		// jobs to be skipped for the rest of the day.
		expect(ran.alignment).toBeGreaterThan(0);
		expect(ran.uxAudit).toBeGreaterThan(0);
	});
});
