import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, runMigrations } from '$lib/server/db';
import {
	forgeEpics,
	forgeSprints,
	forgeTasks,
	users,
	type ForgeCheck
} from '$lib/server/db/schema';
import {
	addSprint,
	approveEpic,
	createEpic,
	markStepped,
	openTask,
	setSprintState,
	setTaskState,
	type ForgeEpic
} from '$lib/server/forge';
import { setSetting } from '$lib/server/settings';
import type { StepOutcome } from './forge-run';

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
let failForgeFor = '';

const ran = {
	layout: 0,
	decay: 0,
	memory: 0,
	groom: 0,
	alignment: 0,
	uxAudit: 0,
	skills: 0,
	forge: 0
};

/** Which epics the driver actually advanced, in the order it chose. */
const forgeSteps: string[] = [];

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
		},
		runSkillOptimiser: async () => {
			ran.skills++;
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

vi.mock('./forge-run', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./forge-run')>();
	return {
		...actual,
		runStep: async (epic: ForgeEpic): Promise<StepOutcome> => {
			ran.forge++;
			if (epic.id === failForgeFor) throw new Error('the workspace would not clone');
			forgeSteps.push(epic.title);
			return { step: 'gate-task', detail: {} };
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
	forgeSteps.length = 0;
	failMemory = false;
	failForgeFor = '';
	db.delete(forgeTasks).run();
	db.delete(forgeSprints).run();
	db.delete(forgeEpics).run();
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
	// The one agent that ships off. Every case here is about whether tick reaches
	// a sweep, so it is switched on explicitly rather than left at its default.
	setSetting('skillOptimiser', { enabled: true, intervalHours: 0 });
	setSetting('skills.lastRun', 0);
	// Forge ships off too, and every case here is about whether tick reaches a
	// sweep — so it is switched on explicitly rather than left at its default.
	setSetting('forge', { enabled: true, stepsPerTick: 1, concurrentEpics: 5 });
	setSetting('budget', { enabled: false, limitUsd: 0, period: 'month' });
});

const CHECKS: ForgeCheck[] = [{ name: 'ok', command: 'true', timeoutMs: 1000 }];

/** A running epic with one task, which the driver has something to do with. */
function epic(title: string) {
	const row = createEpic({ ownerId: ANA, title, repoUrl: 'file:///tmp/x' });
	approveEpic(row.id, ANA, { standingChecks: CHECKS });
	const sprint = addSprint({ epicId: row.id, title: 'One', goal: 'it works' });
	setSprintState(sprint.id, 'running');
	const task = openTask({
		epicId: row.id,
		sprintId: sprint.id,
		title: `${title} task`,
		checks: CHECKS
	});
	return { id: row.id, task };
}

describe('one tick', () => {
	it('reaches every sweep, including the three that shipped uncalled', async () => {
		await tick();
		expect(ran.layout, 'the layout refresh').toBeGreaterThan(0);
		expect(ran.decay, 'the reinforcement decay').toBeGreaterThan(0);
		expect(ran.memory, 'the memory audit').toBeGreaterThan(0);
		expect(ran.groom, 'the Cortex groomer').toBeGreaterThan(0);
		expect(ran.alignment, 'the alignment letter').toBeGreaterThan(0);
		expect(ran.uxAudit, 'the UX audit').toBeGreaterThan(0);
		expect(ran.skills, 'the skill optimiser').toBeGreaterThan(0);
	});

	it('reaches the Forge driver, which is the only thing that advances a build', async () => {
		// Forge has no other caller at all. nextStep says what should happen and
		// runStep does it, but nothing asks either unless this sweep runs — an
		// epic would sit at `running` for ever looking like it was working.
		epic('One');
		await tick();
		expect(ran.forge).toBe(1);
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

	it('gives the step to whichever epic has waited longest', async () => {
		const first = epic('One');
		epic('Two');
		markStepped(first.id);
		await tick();
		// Insertion order would starve whatever was created last the moment there
		// is more work than the pace allows.
		expect(forgeSteps).toEqual(['Two']);
	});

	it('bounds one epic by concurrentTasks', async () => {
		const only = epic('One');
		setTaskState(only.task.id, 'running', { chatId: 'chat-live' });
		await tick();
		// nextStep deliberately offers the next planned task while one is running,
		// so this bound exists here or nowhere.
		expect(forgeSteps).toEqual([]);

		setSetting('forge', { enabled: true, stepsPerTick: 1, concurrentTasks: 2 });
		await tick();
		expect(forgeSteps).toEqual(['One']);
	});

	it('bounds how many epics have a front open at once', async () => {
		const busy = epic('Busy');
		setTaskState(busy.task.id, 'running', { chatId: 'chat-live' });
		epic('Idle');
		setSetting('forge', {
			enabled: true,
			stepsPerTick: 5,
			concurrentTasks: 2,
			concurrentEpics: 1
		});

		await tick();
		// The busy epic may carry on — it is already one of the fronts. The idle
		// one would be opening another, and there is only room for one.
		expect(forgeSteps).toEqual(['Busy']);
	});

	it('does not let one epic failing end the sweep', async () => {
		const broken = epic('Broken');
		epic('Fine');
		failForgeFor = broken.id;
		setSetting('forge', { enabled: true, stepsPerTick: 1, concurrentEpics: 5 });

		await expect(tick()).resolves.toBeUndefined();
		// And the failed step did not spend the tick's allowance: one epic whose
		// workspace will not clone must not stall every epic behind it.
		expect(forgeSteps).toEqual(['Fine']);
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
