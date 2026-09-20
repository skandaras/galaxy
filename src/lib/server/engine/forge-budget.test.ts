import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { db, runMigrations } from '$lib/server/db';
import {
	events,
	forgeEpics,
	forgeSprints,
	forgeTasks,
	notifications,
	usageLog,
	type ForgeCheck
} from '$lib/server/db/schema';
import {
	addSprint,
	approveEpic,
	createEpic,
	forgeSpend,
	forgeSpendSince,
	getEpic,
	markStepped,
	openTask,
	setEpicOverride,
	setEpicState,
	setSprintState,
	setTaskState,
	type ForgeEpic
} from '$lib/server/forge';
import { setSetting } from '$lib/server/settings';
import type { StepOutcome } from './forge-run';

/**
 * The two dials, and what the driver does when one of them is reached.
 *
 * Wall clock and money are independent, and the pair of them is the whole of
 * what an admin sets — so this asserts the arithmetic that decides whether an
 * unattended agent may keep spending, with the step itself mocked out. What a
 * step *does* is forge-run.test.ts's subject; what may start one is this.
 */

const stepped: string[] = [];
/** What a mocked step costs, so a sweep can spend its own allowance as it goes. */
let costPerStep = 0;

vi.mock('./forge-run', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./forge-run')>();
	return {
		...actual,
		runStep: async (epic: ForgeEpic): Promise<StepOutcome> => {
			stepped.push(epic.id);
			if (costPerStep) spend(`forge#${epic.id}#forge-sprint-${stepped.length}`, costPerStep);
			return { step: 'gate-task', detail: {} };
		}
	};
});

const { sweepForge } = await import('./scheduler');

const ALICE = 'user-alice';
const CHECKS: ForgeCheck[] = [{ name: 'ok', command: 'true', timeoutMs: 1000 }];

beforeAll(() => runMigrations());

beforeEach(() => {
	stepped.length = 0;
	costPerStep = 0;
	db.delete(forgeTasks).run();
	db.delete(forgeSprints).run();
	db.delete(forgeEpics).run();
	db.delete(usageLog).run();
	db.delete(notifications).run();
	db.delete(events).run();
	setSetting('budget', { enabled: false, limitUsd: 0, period: 'month' });
	setSetting('forge', { enabled: true, stepsPerTick: 1, concurrentEpics: 5 });
	// The skip notice is rate-limited to one an hour, so a case asserting it must
	// not be reading the previous case's stamp.
	setSetting('forge.lastSkip', 0);
});

/** A running epic with one task in it, ready for the driver to look at. */
function build(title = 'Build') {
	const epic = createEpic({ ownerId: ALICE, title, repoUrl: 'file:///tmp/x' });
	approveEpic(epic.id, ALICE, { standingChecks: CHECKS });
	const sprint = addSprint({ epicId: epic.id, title: 'One', goal: 'it works' });
	setSprintState(sprint.id, 'running');
	const task = openTask({
		epicId: epic.id,
		sprintId: sprint.id,
		title: 'A task',
		checks: CHECKS
	});
	return { epic: getEpic(epic.id, ALICE)!, sprint, task };
}

/** Spend against a chat, priced. `ts` defaults to now. */
function spend(chatId: string, costUsd: number, ts = new Date()) {
	db.insert(usageLog)
		.values({
			id: randomUUID(),
			ts,
			userId: ALICE,
			chatId,
			task: 'coding',
			modelKey: 'm',
			promptTokens: 1,
			completionTokens: 1,
			costUsd,
			status: 'ok'
		})
		.run();
}

/** What a task attempt costs: its own chat, which is how the epic is billed. */
function taskSpend(taskId: string, costUsd: number) {
	const chatId = `chat-${taskId.slice(0, 8)}`;
	setTaskState(taskId, 'planned', { chatId });
	spend(chatId, costUsd);
}

describe('the pace dial', () => {
	it('starts nothing at all while Forge is off', async () => {
		build();
		setSetting('forge', { enabled: false, stepsPerTick: 5 });
		await sweepForge();
		expect(stepped).toEqual([]);
	});

	it('starts nothing at stepsPerTick 0', async () => {
		// The pause that survives a restart, which is the only kind worth having
		// for something that runs for days: it is a settings row, not a flag in a
		// process that dies with the next deploy.
		build();
		setSetting('forge', { enabled: true, stepsPerTick: 0 });
		await sweepForge();
		expect(stepped).toEqual([]);
	});

	it('starts exactly as many steps as it is allowed', async () => {
		build('One');
		build('Two');
		build('Three');
		setSetting('forge', { enabled: true, stepsPerTick: 2, concurrentEpics: 5 });
		await sweepForge();
		expect(stepped).toHaveLength(2);
	});
});

describe('the epic ceiling', () => {
	it('pauses the epic with the cap as its reason, rather than stepping it', async () => {
		const { epic, task } = build();
		taskSpend(task.id, 3);
		setSetting('forge', { enabled: true, stepsPerTick: 1, maxUsdPerEpic: 2 });

		await sweepForge();
		expect(stepped).toEqual([]);
		const after = getEpic(epic.id, ALICE)!;
		expect(after.state).toBe('paused');
		expect(after.stateReason).toContain('$3.00');
		expect(after.stateReason).toContain('$2.00');
	});

	it('rings the bell once, not once a tick', async () => {
		const { task } = build();
		taskSpend(task.id, 3);
		setSetting('forge', { enabled: true, stepsPerTick: 1, maxUsdPerEpic: 2 });

		await sweepForge();
		await sweepForge();
		await sweepForge();
		// The dedupe is the pause itself — a paused epic leaves dueEpics, which is
		// what stops this repeating. notify() has none of its own.
		const bell = db.select().from(notifications).all();
		expect(bell).toHaveLength(1);
		expect(bell[0].kind).toBe('forge-blocked');
	});

	it('leaves a paused epic alone on every tick after', async () => {
		const { epic } = build();
		setEpicState(epic.id, 'paused', 'spend ceiling');
		setSetting('forge', { enabled: true, stepsPerTick: 5 });

		await sweepForge();
		expect(stepped).toEqual([]);
	});

	it('is checked between steps and never inside one', async () => {
		// The rule research states and this borrows: a step is the unit that
		// produces something usable, so an epic that crosses its ceiling mid-step
		// finishes that step and stops before the next. Stopping inside one would
		// leave a half-written file and a task nobody can judge.
		const { epic, task } = build();
		taskSpend(task.id, 1);
		setSetting('forge', { enabled: true, stepsPerTick: 1, maxUsdPerEpic: 2 });

		await sweepForge();
		expect(stepped).toEqual([epic.id]);
		expect(getEpic(epic.id, ALICE)!.state).toBe('running');

		// That step is what took it over.
		spend(`chat-${task.id.slice(0, 8)}`, 1.5);
		await sweepForge();
		expect(stepped).toEqual([epic.id]);
		expect(getEpic(epic.id, ALICE)!.state).toBe('paused');
	});

	it('lets an override raise the instance ceiling, and 0 inherit it', async () => {
		const { epic, task } = build();
		taskSpend(task.id, 3);
		setSetting('forge', { enabled: true, stepsPerTick: 1, maxUsdPerEpic: 2 });

		setEpicOverride(epic.id, 10);
		await sweepForge();
		expect(stepped).toEqual([epic.id]);

		// Back to 0 and the instance setting governs again, exactly as
		// feed_topics.intervalHours does.
		setEpicOverride(epic.id, 0);
		await sweepForge();
		expect(stepped).toEqual([epic.id]);
		expect(getEpic(epic.id, ALICE)!.state).toBe('paused');
	});

	it('does nothing at all when no ceiling is set', async () => {
		const { epic, task } = build();
		taskSpend(task.id, 500);
		setSetting('forge', { enabled: true, stepsPerTick: 1, maxUsdPerEpic: 0 });

		await sweepForge();
		expect(stepped).toEqual([epic.id]);
	});
});

describe('the daily ceiling', () => {
	it('stops the whole sweep, not one epic', async () => {
		const a = build('One');
		const b = build('Two');
		taskSpend(a.task.id, 4);
		taskSpend(b.task.id, 1);
		setSetting('forge', { enabled: true, stepsPerTick: 5, maxUsdPerDay: 5 });

		await sweepForge();
		expect(stepped).toEqual([]);
		// Nothing is paused: the day rolls, and an epic parked for somebody else's
		// spending would need a person to notice and un-park it.
		expect(getEpic(a.epic.id, ALICE)!.state).toBe('running');
	});

	it('ignores what was spent outside the window', async () => {
		const { epic, task } = build();
		taskSpend(task.id, 1);
		spend(`chat-${task.id.slice(0, 8)}`, 100, new Date(Date.now() - 36 * 3_600_000));
		setSetting('forge', { enabled: true, stepsPerTick: 1, maxUsdPerDay: 5 });

		await sweepForge();
		expect(stepped).toEqual([epic.id]);
	});

	it('is re-read between steps, not once for the tick', async () => {
		// The failure this guards: at twenty steps a tick, the first few can spend
		// the whole day's allowance between them. A ceiling only checked at the top
		// is one the rest of the tick sails straight past.
		build('One');
		build('Two');
		build('Three');
		costPerStep = 3;
		setSetting('forge', {
			enabled: true,
			stepsPerTick: 5,
			concurrentEpics: 5,
			maxUsdPerDay: 5
		});

		await sweepForge();
		expect(stepped).toHaveLength(2);
	});

	it('says why it skipped, once an hour rather than once a tick', async () => {
		const { task } = build();
		taskSpend(task.id, 9);
		setSetting('forge', { enabled: true, stepsPerTick: 1, maxUsdPerDay: 5 });

		await sweepForge();
		await sweepForge();
		const filed = db.select().from(events).all();
		expect(filed).toHaveLength(1);
		expect(filed[0].name).toBe('forge.sweep');
		expect(JSON.stringify(filed[0].detail)).toContain('for the day');
	});
});

describe('the platform cap', () => {
	it('outranks Forge’s own dials', async () => {
		// An agent nobody is watching is the last thing that should spend what is
		// left of a capped month.
		const { task } = build();
		taskSpend(task.id, 30);
		setSetting('budget', { enabled: true, limitUsd: 25, period: 'month' });
		setSetting('forge', { enabled: true, stepsPerTick: 5, maxUsdPerEpic: 0 });

		await sweepForge();
		expect(stepped).toEqual([]);
		expect(JSON.stringify(db.select().from(events).all())).toContain('budget cap');
	});
});

describe('what an epic’s spend is summed from', () => {
	it('counts its tasks’ chats', () => {
		const { epic, task } = build();
		taskSpend(task.id, 2.5);
		expect(forgeSpend(epic.id)).toBe(2.5);
	});

	it('counts the planning runs, which have no chat at all', () => {
		// The charter, the sprint plans and the reviews are headless, on a
		// synthetic id carrying the epic. Missing them would leave the ceiling
		// bounding only the coding half of the bill.
		const { epic, task } = build();
		taskSpend(task.id, 1);
		spend(`forge#${epic.id}#forge-charter-abcd1234`, 0.75);
		spend(`forge#${epic.id}#forge-sprint-beef5678`, 0.25);
		expect(forgeSpend(epic.id)).toBe(2);
	});

	it('does not count another epic’s', () => {
		const a = build('One');
		const b = build('Two');
		taskSpend(a.task.id, 1);
		spend(`forge#${b.epic.id}#forge-charter-abcd1234`, 9);
		expect(forgeSpend(a.epic.id)).toBe(1);
	});

	it('sums every epic for the day, within the window', () => {
		const a = build('One');
		const b = build('Two');
		taskSpend(a.task.id, 1);
		taskSpend(b.task.id, 2);
		spend(`forge#${a.epic.id}#forge-review-cafe0001`, 0.5);
		spend(`chat-elsewhere`, 100);
		expect(forgeSpendSince(Date.now() - 86_400_000)).toBe(3.5);
	});
});

describe('fairness', () => {
	it('gives the tick to whichever epic has waited longest', async () => {
		const a = build('One');
		const b = build('Two');
		markStepped(a.epic.id);
		setSetting('forge', { enabled: true, stepsPerTick: 1, concurrentEpics: 5 });

		await sweepForge();
		// Insertion order would starve whatever was created last as soon as there
		// is more work than the pace allows.
		expect(stepped).toEqual([b.epic.id]);
	});
});
