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
import { purgeEpic, reconcileForge } from './forge-recover';

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

describe('narrowing it to one build', () => {
	it('leaves another build’s stranded task alone', () => {
		// Resuming an epic needs this: the whole-table sweep would charge an
		// attempt against a task in a build nobody had touched.
		const mine = build();
		const theirs = build();
		setTaskState(mine.task.id, 'running', { chatId: 'chat-a' });
		setTaskState(theirs.task.id, 'running', { chatId: 'chat-b' });

		expect(reconcileForge({ epicId: mine.epic.id })).toBe(1);
		expect(taskRow(mine.task.id, mine.epic.id).state).toBe('planned');
		expect(taskRow(theirs.task.id, theirs.epic.id).state).toBe('running');
	});

	it('is what stops a resumed build sitting at running doing nothing', () => {
		// tasksInFlight counts a stranded task, so the sweep decides the epic is
		// at its concurrency limit and nextStep will not step past it.
		const { epic, task } = build();
		setTaskState(task.id, 'running', { chatId: 'chat-gone' });
		expect(tasksInFlight(epic.id)).toBe(1);

		reconcileForge({ epicId: epic.id });
		expect(tasksInFlight(epic.id)).toBe(0);
	});
});

describe('a person stopping their own build', () => {
	it('ends the turn that was running rather than stepping around it', () => {
		// Setting the epic's state alone left the coding turn going, so the page
		// said paused while the runner carried on and the bill with it.
		const { epic, task } = build();
		// Its own chat id: the live-job map is module level and nothing clears it
		// between cases, so a reused id finds the previous test's job instead.
		setTaskState(task.id, 'running', { chatId: 'chat-halt' });
		const job = createJob({
			chatId: 'chat-halt',
			userId: ALICE,
			task: 'coding',
			persist: false
		});

		expect(reconcileForge({ epicId: epic.id, cancel: true })).toBe(1);
		// The signal, not the status: `cancelJob` asks the loop to stop and the
		// loop is what marks the row finished as it unwinds. Here there is no
		// loop, so the abort having been raised is the whole of the evidence.
		expect(job.controller.signal.aborted).toBe(true);
		expect(taskRow(task.id, epic.id).state).toBe('planned');
	});

	it('spends no attempt, because a pause is not the task failing', () => {
		// The boot path counts one so a task that reliably takes the process down
		// eventually parks. Somebody pressing Pause is not that, and counting it
		// would park a task for being interrupted three times.
		const { epic, task } = build();
		setTaskState(task.id, 'running', { chatId: 'chat-halt-attempts' });
		createJob({ chatId: 'chat-halt-attempts', userId: ALICE, task: 'coding', persist: false });

		reconcileForge({ epicId: epic.id, cancel: true });
		expect(taskRow(task.id, epic.id).attempts).toBe(0);
	});
});

describe('deleting a build', () => {
	it('refuses while one of its turns is still live', () => {
		// The turn would carry on writing to a workspace whose task row had gone.
		const { epic, task } = build();
		setTaskState(task.id, 'running', { chatId: 'chat-purge-live' });
		const job = createJob({
			chatId: 'chat-purge-live',
			userId: ALICE,
			task: 'coding',
			persist: false
		});

		expect(purgeEpic(getEpic(epic.id, ALICE)!, ALICE)).toEqual({ ok: false, reason: 'busy' });
		expect(getEpic(epic.id, ALICE)).not.toBeNull();
		cancelJob(job);
	});

	it('takes the build once nothing is running', () => {
		const { epic, task } = build();
		setTaskState(task.id, 'running', { chatId: 'chat-gone' });

		expect(purgeEpic(getEpic(epic.id, ALICE)!, ALICE)).toEqual({ ok: true, tasks: 1 });
		expect(getEpic(epic.id, ALICE)).toBeNull();
		expect(listTasks(epic.id)).toEqual([]);
	});
});
