import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, runMigrations } from '$lib/server/db';
import {
	events,
	forgeEpics,
	forgeSprints,
	forgeTasks,
	jobs,
	type ForgeCheck
} from '$lib/server/db/schema';
import {
	addSprint,
	approveEpic,
	createEpic,
	getEpic,
	listSprints,
	listTasks,
	openTask,
	setSprintState,
	setTaskState,
	tasksInFlight
} from '$lib/server/forge';
import { cancelJob, createJob } from './jobs';
import { nextStep } from './forge-step';
import { reconcileForge } from './forge-recover';

/**
 * What a restart leaves behind inside an epic.
 *
 * `closeAbandonedJobs` has its own suite and tidies the job row. These are the
 * *other* row — the task — which nothing tidied before this, and which left the
 * epic claiming work was in flight that had died with the previous process.
 */

const ALICE = 'user-alice';
const CHECKS: ForgeCheck[] = [{ name: 'ok', command: 'true', timeoutMs: 1000 }];

beforeAll(() => runMigrations());

beforeEach(() => {
	db.delete(forgeTasks).run();
	db.delete(forgeSprints).run();
	db.delete(forgeEpics).run();
	db.delete(events).run();
	db.delete(jobs).run();
});

/** An approved, running epic with one running sprint and one task in it. */
function build() {
	const epic = createEpic({ ownerId: ALICE, title: 'Build', repoUrl: 'file:///tmp/x' });
	approveEpic(epic.id, ALICE, { standingChecks: CHECKS });
	const sprint = addSprint({ epicId: epic.id, title: 'One', goal: 'it works' });
	setSprintState(sprint.id, 'running');
	const task = openTask({
		epicId: epic.id,
		sprintId: sprint.id,
		title: 'Do the thing',
		checks: CHECKS
	});
	return { epic, sprint, task };
}

const taskRow = (id: string, epicId: string) => listTasks(epicId).find((t) => t.id === id)!;
const sprintRow = (id: string, epicId: string) => listSprints(epicId).find((s) => s.id === id)!;

describe('a task the process died under', () => {
	it('goes back to planned with an attempt counted', () => {
		const { epic, task } = build();
		setTaskState(task.id, 'running', { chatId: 'chat-gone' });

		expect(reconcileForge()).toBe(1);
		const after = taskRow(task.id, epic.id);
		expect(after.state).toBe('planned');
		// The attempt is the point: a task that reliably takes the process down
		// has to run out of attempts eventually rather than restart for ever.
		expect(after.attempts).toBe(1);
	});

	it('is the next thing the driver picks up', () => {
		const { epic, sprint, task } = build();
		setTaskState(task.id, 'running', { chatId: 'chat-gone' });
		reconcileForge();

		expect(nextStep({ epic: getEpic(epic.id, ALICE)!, sprints: listSprints(epic.id), tasks: listTasks(epic.id) })).toEqual(
			{ kind: 'run-task', taskId: task.id }
		);
		// And the epic itself was never touched — it is the task that stalled.
		expect(getEpic(epic.id, ALICE)!.state).toBe('running');
		expect(sprintRow(sprint.id, epic.id).state).toBe('running');
	});

	it('stops the epic looking permanently busy to the driver', () => {
		// The failure this exists for. tasksInFlight counts `running`, so a task
		// nothing will ever finish holds the epic at its concurrency limit and the
		// sweep skips it on every tick from then on.
		const { epic, task } = build();
		setTaskState(task.id, 'running', { chatId: 'chat-gone' });
		expect(tasksInFlight(epic.id)).toBe(1);

		reconcileForge();
		expect(tasksInFlight(epic.id)).toBe(0);
	});

	it('files an event, so a recovery is never silent', () => {
		const { task } = build();
		setTaskState(task.id, 'running', { chatId: 'chat-gone' });
		reconcileForge();

		const filed = db.select().from(events).all();
		expect(filed).toHaveLength(1);
		expect(filed[0].name).toBe('forge.recovered');
		expect(JSON.stringify(filed[0].detail)).toContain(task.id);
	});
});

describe('a task that is genuinely still working', () => {
	it('is left exactly where it is', () => {
		const { epic, task } = build();
		setTaskState(task.id, 'running', { chatId: 'chat-live' });
		const job = createJob({ chatId: 'chat-live', userId: ALICE, task: 'coding', persist: false });

		expect(reconcileForge()).toBe(0);
		expect(taskRow(task.id, epic.id)).toMatchObject({ state: 'running', attempts: 0 });
		cancelJob(job);
	});
});

describe('a task waiting for its gate', () => {
	it('is left at gating rather than restarted', () => {
		// code_sessions is a table and the workspace is on disk, so the work a gate
		// judges survives the restart that interrupted it. Resetting would throw
		// away a finished attempt and charge it an attempt for the privilege.
		const { epic, task } = build();
		setTaskState(task.id, 'gating', { chatId: 'chat-gone' });

		expect(reconcileForge()).toBe(0);
		expect(taskRow(task.id, epic.id)).toMatchObject({ state: 'gating', attempts: 0 });
	});
});

describe('a sprint the process died while planning', () => {
	it('goes back to outlined, with no attempt spent', () => {
		const { epic, sprint } = build();
		setSprintState(sprint.id, 'planning');

		expect(reconcileForge()).toBe(1);
		const after = sprintRow(sprint.id, epic.id);
		expect(after.state).toBe('outlined');
		// A sprint's attempts are its gate's currency. Spending one here would park
		// it early for a reason that had nothing to do with its code.
		expect(after.attempts).toBe(0);
	});

	it('is the difference between a stuck epic and a moving one', () => {
		// nextStep returns null on a planning sprint by design, so this state left
		// alone is not a stalled task — it is an epic that silently stopped.
		const { epic, sprint } = build();
		db.delete(forgeTasks).run();
		setSprintState(sprint.id, 'planning');
		const snap = () => ({
			epic: getEpic(epic.id, ALICE)!,
			sprints: listSprints(epic.id),
			tasks: listTasks(epic.id)
		});
		expect(nextStep(snap())).toBeNull();

		reconcileForge();
		expect(nextStep(snap())).toEqual({ kind: 'plan-sprint', sprintId: sprint.id });
	});

	it('leaves a sprint at gating alone', () => {
		const { epic, sprint } = build();
		setSprintState(sprint.id, 'gating');
		expect(reconcileForge()).toBe(0);
		expect(sprintRow(sprint.id, epic.id).state).toBe('gating');
	});
});
