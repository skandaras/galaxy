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

let failLearning = false;

const ran = {
	learning: 0,
	profile: 0,
	alignment: 0,
	uxAudit: 0,
	skills: 0
};

vi.mock('./profile-learn', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./profile-learn')>();
	return {
		...actual,
		runLearning: async () => {
			ran.learning++;
			if (failLearning) throw new Error('provider exploded');
			return { ran: true };
		}
	};
});

vi.mock('$lib/server/profile', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/profile')>();
	return {
		...actual,
		expireDue: () => {
			ran.profile++;
			return 0;
		}
	};
});

vi.mock('./memory', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./memory')>();
	return {
		...actual,
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
	failLearning = false;
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
	setSetting('profile', { enabled: true, intervalHours: 1 });
	setSetting('alignment', { enabled: true, synthesisIntervalHours: 0 });
	setSetting('uxaudit', { enabled: true, intervalHours: 0 });
	setSetting('alignment.userEnabled', true, ANA);
	setSetting('profile.learn', true, ANA);
	// Reset explicitly rather than relied on: settings persist between tests in
	// one database, so a case that opts a user out would otherwise silently opt
	// them out of every case after it.
	setSetting('profile.lastRun', 0, ANA);
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
		expect(ran.learning, 'learning for the profile').toBeGreaterThan(0);
		expect(ran.profile, 'the profile sweep').toBeGreaterThan(0);
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
		setSetting('profile', { enabled: false, intervalHours: 1 });
		await tick();
		expect(ran.learning).toBe(0);
		// Expiry calls no model and is not what the switch is about.
		expect(ran.profile).toBeGreaterThan(0);
		expect(ran.uxAudit).toBeGreaterThan(0);
	});

	it('skips a user who turned learning off for themselves', async () => {
		setSetting('profile.learn', false, ANA);
		await tick();
		expect(ran.learning).toBe(0);
		// Their switch is about being learnt from, not about the jobs that run
		// for everybody.
		expect(ran.alignment).toBeGreaterThan(0);
	});

	it('does not let one sweep failing take the rest of the tick with it', async () => {
		failLearning = true;
		await expect(tick()).resolves.toBeUndefined();
		// One person's provider falling over is not a reason for everybody else's
		// jobs to be skipped for the rest of the day.
		expect(ran.alignment).toBeGreaterThan(0);
		expect(ran.uxAudit).toBeGreaterThan(0);
	});
});
