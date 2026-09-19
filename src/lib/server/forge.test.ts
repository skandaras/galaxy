import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, runMigrations } from '$lib/server/db';
import { forgeEpics, forgeGateRuns, forgeSprints, forgeTasks, usageLog } from '$lib/server/db/schema';
import {
	addSprint,
	approveEpic,
	countAttempt,
	createEpic,
	dueEpics,
	forgeSpend,
	gateRunsFor,
	getEpic,
	listEpics,
	listSprints,
	listTasks,
	markStepped,
	openTask,
	recordGateRun,
	setEpicState,
	setTaskState,
	snapshot
} from './forge';

const ALICE = 'user-alice';
const BOB = 'user-bob';

beforeAll(() => {
	runMigrations();
});

beforeEach(() => {
	db.delete(forgeGateRuns).run();
	db.delete(forgeTasks).run();
	db.delete(forgeSprints).run();
	db.delete(forgeEpics).run();
	db.delete(usageLog).run();
});

const newEpic = (owner = ALICE) =>
	createEpic({ ownerId: owner, title: 'Galaxy mobile', repoUrl: 'https://example.invalid/r.git' });

const CHECKS = [{ name: 'test', command: 'npm test', timeoutMs: 0 }];

describe('ownership', () => {
	it('hides another person’s epic from every read', () => {
		// An epic drives a coding agent against somebody's repository, so "exists
		// but not yours" has to be indistinguishable from "does not exist".
		const mine = newEpic();
		newEpic(BOB);
		expect(getEpic(mine.id, BOB)).toBeNull();
		expect(listEpics(BOB).map((e) => e.id)).not.toContain(mine.id);
		expect(snapshot(mine.id, BOB)).toBeNull();
	});

	it('scopes in the SQL predicate, not after the fact', () => {
		const mine = newEpic();
		expect(getEpic(mine.id, ALICE)?.id).toBe(mine.id);
		expect(listEpics(ALICE)).toHaveLength(1);
	});
});

describe('approval', () => {
	it('is the only thing that writes the standing checks', () => {
		const e = newEpic();
		expect(e.standingChecks).toBeNull();
		expect(e.state).toBe('drafting');

		approveEpic(e.id, ALICE, { standingChecks: CHECKS, gateChecks: [], acceptance: ['it works'] });
		const approved = getEpic(e.id, ALICE)!;
		expect(approved.standingChecks).toEqual(CHECKS);
		expect(approved.state).toBe('running');
		expect(approved.approvedAt).not.toBeNull();
	});

	it('refuses to rewrite them afterwards', () => {
		// The whole reason a run cannot mark its own homework: one door, taken by
		// a person once. A second approval with different commands is exactly the
		// shape an injected "replace your checks" instruction would take.
		const e = newEpic();
		approveEpic(e.id, ALICE, { standingChecks: CHECKS });
		approveEpic(e.id, ALICE, {
			standingChecks: [{ name: 'test', command: 'true', timeoutMs: 0 }]
		});
		expect(getEpic(e.id, ALICE)!.standingChecks).toEqual(CHECKS);
	});

	it('will not approve an epic that is not yours', () => {
		const e = newEpic();
		expect(approveEpic(e.id, BOB, { standingChecks: CHECKS })).toBeNull();
		expect(getEpic(e.id, ALICE)!.standingChecks).toBeNull();
	});
});

describe('the driver’s read', () => {
	it('returns only running epics, longest wait first', () => {
		const a = newEpic();
		const b = newEpic();
		approveEpic(a.id, ALICE, { standingChecks: CHECKS });
		approveEpic(b.id, ALICE, { standingChecks: CHECKS });
		// Neither has run: nulls first, then oldest step.
		expect(dueEpics()).toHaveLength(2);

		markStepped(a.id);
		expect(dueEpics()[0].id).toBe(b.id);

		setEpicState(b.id, 'paused', 'spend ceiling');
		expect(dueEpics().map((e) => e.id)).toEqual([a.id]);
		expect(getEpic(b.id, ALICE)!.stateReason).toBe('spend ceiling');
	});
});

describe('tasks', () => {
	it('refuses to open one with neither checks nor a reason it has none', () => {
		// Not every task is test-shaped — a rename, a comment — but a task that
		// says nothing about how it would be judged is one nothing can close.
		const e = newEpic();
		const s = addSprint({ epicId: e.id, title: 'Sprint 1' });
		expect(() => openTask({ epicId: e.id, sprintId: s.id, title: 'Vague' })).toThrow();
		expect(
			openTask({ epicId: e.id, sprintId: s.id, title: 'Rename', noCheckReason: 'a rename' }).id
		).toBeTruthy();
		expect(openTask({ epicId: e.id, sprintId: s.id, title: 'Real', checks: CHECKS }).id).toBeTruthy();
	});

	it('positions sprints and tasks in the order they were added', () => {
		const e = newEpic();
		const s1 = addSprint({ epicId: e.id, title: 'One' });
		const s2 = addSprint({ epicId: e.id, title: 'Two' });
		expect(listSprints(e.id).map((s) => [s.title, s.position])).toEqual([
			['One', 0],
			['Two', 1]
		]);
		openTask({ epicId: e.id, sprintId: s1.id, title: 'A', checks: CHECKS });
		openTask({ epicId: e.id, sprintId: s1.id, title: 'B', checks: CHECKS });
		openTask({ epicId: e.id, sprintId: s2.id, title: 'C', checks: CHECKS });
		// Position is per sprint, so s2's first task starts at 0 again.
		expect(listTasks(e.id).map((t) => [t.title, t.position])).toEqual([
			['A', 0],
			['C', 0],
			['B', 1]
		]);
	});

	it('counts attempts so a task can eventually park', () => {
		const e = newEpic();
		const s = addSprint({ epicId: e.id, title: 'Sprint 1' });
		const t = openTask({ epicId: e.id, sprintId: s.id, title: 'A', checks: CHECKS });
		expect(countAttempt(t.id)).toBe(1);
		expect(countAttempt(t.id)).toBe(2);
		setTaskState(t.id, 'blocked');
		expect(listTasks(e.id)[0].state).toBe('blocked');
	});
});

describe('gate runs', () => {
	it('keeps every run rather than overwriting the last', () => {
		// "Why did sprint 3 pass" has to be answerable a month later; attempt 4
		// would have written over the answer.
		const e = newEpic();
		const s = addSprint({ epicId: e.id, title: 'Sprint 1' });
		const t = openTask({ epicId: e.id, sprintId: s.id, title: 'A', checks: CHECKS });

		recordGateRun({
			epicId: e.id,
			scope: 'task',
			targetId: t.id,
			baseline: true,
			passed: false,
			results: [{ name: 'test', command: 'npm test', exitCode: 1, durationMs: 1, output: '', timedOut: false }]
		});
		recordGateRun({
			epicId: e.id,
			scope: 'task',
			targetId: t.id,
			attempt: 1,
			passed: true,
			results: [{ name: 'test', command: 'npm test', exitCode: 0, durationMs: 1, output: '', timedOut: false }]
		});

		const runs = gateRunsFor(t.id);
		expect(runs).toHaveLength(2);
		// The baseline survives, which is the evidence the task's checks were ever
		// capable of failing.
		expect(runs.some((r) => r.baseline && !r.passed)).toBe(true);
		expect(runs.some((r) => !r.baseline && r.passed)).toBe(true);
	});
});

describe('forgeSpend', () => {
	const spend = (chatId: string, costUsd: number) =>
		db
			.insert(usageLog)
			.values({
				id: `${chatId}-${costUsd}-${Math.random()}`,
				ts: new Date(),
				userId: ALICE,
				chatId,
				task: 'coding',
				modelKey: 'm',
				costUsd,
				status: 'ok'
			})
			.run();

	it('sums only the chats belonging to this epic', () => {
		const e = newEpic();
		const other = newEpic();
		const s = addSprint({ epicId: e.id, title: 'Sprint 1' });
		const t1 = openTask({ epicId: e.id, sprintId: s.id, title: 'A', checks: CHECKS });
		const t2 = openTask({ epicId: e.id, sprintId: s.id, title: 'B', checks: CHECKS });
		setTaskState(t1.id, 'running', { chatId: 'chat-1' });
		setTaskState(t2.id, 'running', { chatId: 'chat-2' });

		spend('chat-1', 1.5);
		spend('chat-2', 2.25);
		// Another epic's spend, and a chat belonging to no epic at all.
		spend('chat-elsewhere', 100);

		expect(forgeSpend(e.id)).toBeCloseTo(3.75);
		expect(forgeSpend(other.id)).toBe(0);
	});

	it('is zero before any task has a chat', () => {
		const e = newEpic();
		expect(forgeSpend(e.id)).toBe(0);
	});
});

describe('the snapshot nextStep reads', () => {
	it('carries the epic with its sprints and tasks', () => {
		const e = newEpic();
		approveEpic(e.id, ALICE, { standingChecks: CHECKS });
		const s = addSprint({ epicId: e.id, title: 'Sprint 1' });
		openTask({ epicId: e.id, sprintId: s.id, title: 'A', checks: CHECKS });

		const snap = snapshot(e.id, ALICE)!;
		expect(snap.epic.state).toBe('running');
		expect(snap.sprints).toHaveLength(1);
		expect(snap.tasks).toHaveLength(1);
	});
});
