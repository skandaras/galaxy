import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { db, dataDir, runMigrations } from '$lib/server/db';
import {
	forgeEpics,
	forgeGateRuns,
	forgeSprints,
	forgeTasks,
	notifications,
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
	type ForgeEpic
} from '$lib/server/forge';
import { setSetting } from '$lib/server/settings';
import { createSession } from './coding/session';
import { runStep } from './forge-run';

/**
 * The step dispatcher against a real repository, with no model anywhere.
 *
 * Gating, merging and parking are the parts that decide whether a build is
 * trustworthy, and none of them needs a model: the checks are shell commands
 * and the merge is git. Only starting a task does, and that is covered by the
 * end-to-end smoke suite against the mock provider.
 */

const ALICE = 'user-alice';
const ORIGIN = join(dataDir, 'origin-forge');
const BARE = `${ORIGIN}.git`;
const AS = '-c user.email=t@t -c user.name=t';

const git = (cwd: string, args: string) =>
	execSync(`git ${args}`, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const check = (name: string, command: string): ForgeCheck => ({ name, command, timeoutMs: 30_000 });

beforeAll(() => {
	runMigrations();
	rmSync(ORIGIN, { recursive: true, force: true });
	rmSync(BARE, { recursive: true, force: true });
	mkdirSync(ORIGIN, { recursive: true });
	git(ORIGIN, 'init -q -b main');
	writeFileSync(join(ORIGIN, 'README.md'), 'start\n');
	git(ORIGIN, 'add -A');
	git(ORIGIN, `${AS} commit -qm init`);
	git(dataDir, `clone -q --bare ${JSON.stringify(ORIGIN)} ${JSON.stringify(BARE)}`);
});

afterAll(() => {
	rmSync(join(dataDir, 'workspaces'), { recursive: true, force: true });
});

beforeEach(() => {
	db.delete(forgeGateRuns).run();
	db.delete(forgeTasks).run();
	db.delete(forgeSprints).run();
	db.delete(forgeEpics).run();
	db.delete(notifications).run();
	setSetting('forge', { maxAttempts: 2 });
});

/** An approved epic with one running sprint, ready for a task. */
function build(standing: ForgeCheck[] = [check('ok', 'true')]) {
	const epic = createEpic({
		ownerId: ALICE,
		title: 'Test build',
		repoUrl: BARE,
		repoName: 'local/forge',
		baseBranch: 'main'
	});
	approveEpic(epic.id, ALICE, { standingChecks: standing });
	const sprint = addSprint({ epicId: epic.id, title: 'One', goal: 'it works' });
	setSprintState(sprint.id, 'running');
	return { epic: getEpic(epic.id, ALICE) as ForgeEpic, sprint };
}

/**
 * A task that has already "run": a real session with a real commit on its work
 * branch, parked at `gating` exactly where the coding turn would leave it.
 */
async function taskReadyToGate(
	epic: ForgeEpic,
	sprintId: string,
	checks: ForgeCheck[],
	file = 'added.txt'
) {
	const task = openTask({
		epicId: epic.id,
		sprintId,
		title: `Add ${file}`,
		checks,
		noCheckReason: checks.length ? '' : 'nothing to check'
	});
	const session = await createSession({
		userId: ALICE,
		repoUrl: epic.repoUrl,
		repoName: epic.repoName,
		mode: 'implement',
		from: epic.integrationBranch
	});
	const dir = join(dataDir, session.workspaceRel);
	writeFileSync(join(dir, file), 'work\n');
	git(dir, 'add -A');
	git(dir, `${AS} commit -qm ${JSON.stringify(`add ${file}`)}`);
	setTaskState(task.id, 'gating', { chatId: session.chatId, branch: session.workBranch });
	return { task, session };
}

describe('gating a task', () => {
	it('merges into the integration branch and pushes it when the gate is green', async () => {
		const { epic, sprint } = build();
		await taskReadyToGate(epic, sprint.id, [check('own', 'true')]);

		const out = await runStep(epic, ALICE);
		expect(out.step).toBe('gate-task');
		expect(out.detail?.passed).toBe(true);
		expect(listTasks(epic.id)[0].state).toBe('done');
		// The whole point of an integration branch: the next task can clone this.
		expect(git(BARE, `log --oneline ${epic.integrationBranch}`)).toContain('add added.txt');
	});

	it('keeps the work off the branch when a check fails, and tries again', async () => {
		const { epic, sprint } = build();
		await taskReadyToGate(epic, sprint.id, [check('own', 'false')]);

		const out = await runStep(epic, ALICE);
		expect(out.detail?.passed).toBe(false);
		expect(out.detail?.willRetry).toBe(true);
		// Back to planned for another attempt, and nothing landed.
		expect(listTasks(epic.id)[0].state).toBe('planned');
		expect(listTasks(epic.id)[0].attempts).toBe(1);
		expect(() => git(BARE, `log --oneline ${epic.integrationBranch}`)).toThrow();
	});

	it('fails the gate on a standing check even when the task’s own passes', async () => {
		// The repository's checks are not negotiable by the task: that is what
		// "standing" means.
		const { epic, sprint } = build([check('repo', 'false')]);
		await taskReadyToGate(epic, sprint.id, [check('own', 'true')]);

		expect((await runStep(epic, ALICE)).detail?.passed).toBe(false);
	});

	it('parks the task and rings the bell once it runs out of attempts', async () => {
		const { epic, sprint } = build();
		const { task } = await taskReadyToGate(epic, sprint.id, [check('own', 'false')]);
		// One attempt already spent; maxAttempts is 2.
		await runStep(epic, ALICE);
		setTaskState(task.id, 'gating');

		const out = await runStep(epic, ALICE);
		expect(out.detail?.blocked).toBe(true);
		expect(listTasks(epic.id)[0].state).toBe('blocked');
		// The driver subscribes to its own coding job, which suppresses failJob's
		// bell — so if Forge did not ring its own, nothing would say this stopped.
		const bell = db.select().from(notifications).all();
		expect(bell).toHaveLength(1);
		expect(bell[0].kind).toBe('forge-blocked');
		expect(bell[0].title).toContain('is stuck');
	});

	it('records every gate run rather than overwriting the last', async () => {
		const { epic, sprint } = build();
		const { task } = await taskReadyToGate(epic, sprint.id, [check('own', 'false')]);
		await runStep(epic, ALICE);
		setTaskState(task.id, 'gating');
		await runStep(epic, ALICE);

		const runs = db.select().from(forgeGateRuns).all();
		expect(runs).toHaveLength(2);
		expect(runs.every((r) => !r.passed)).toBe(true);
		// "Why did this park" is answerable from the rows, a month later.
		expect(JSON.stringify(runs)).toContain('own');
	});
});

describe('a blocked task', () => {
	it('does not stall the tasks after it, but does stop its sprint closing', async () => {
		const { epic, sprint } = build();
		const { task } = await taskReadyToGate(epic, sprint.id, [check('own', 'false')], 'first.txt');
		const second = openTask({
			epicId: epic.id,
			sprintId: sprint.id,
			title: 'The next one',
			checks: [check('own', 'true')],
			position: 1
		});

		await runStep(epic, ALICE);
		setTaskState(task.id, 'gating');
		await runStep(epic, ALICE);
		expect(listTasks(epic.id).find((t) => t.id === task.id)?.state).toBe('blocked');

		// The next task is what comes next, not a stalled epic.
		setTaskState(second.id, 'done');
		const out = await runStep(epic, ALICE);
		expect(out.step).toBe('none');
		expect(listSprints(epic.id)[0].state).toBe('running');
	});
});

describe('closing a sprint', () => {
	it('gates the integration branch and finishes on green', async () => {
		const { epic, sprint } = build();
		const { task } = await taskReadyToGate(epic, sprint.id, [check('own', 'true')]);
		await runStep(epic, ALICE);
		expect(listTasks(epic.id).find((t) => t.id === task.id)?.state).toBe('done');

		// No model is configured, so the review run reports that it could not
		// write — and the sprint still closes, because the gate is what decides.
		const out = await runStep(epic, ALICE);
		expect(out.step).toBe('close-sprint');
		expect(out.detail?.passed).toBe(true);
		expect(listSprints(epic.id)[0].state).toBe('done');
	});

	it('parks the epic when the sprint gate keeps failing', async () => {
		const { epic, sprint } = build([check('repo', 'true')]);
		await taskReadyToGate(epic, sprint.id, [check('own', 'true')]);
		await runStep(epic, ALICE);

		// The sprint gate runs the epic's gate checks too; make those the ones
		// that fail, so the tasks passed and the sprint as a whole does not.
		db.update(forgeEpics)
			.set({ gateChecks: [check('smoke', 'false')] })
			.run();

		await runStep(epic, ALICE);
		expect(listSprints(epic.id)[0].state).toBe('running');
		await runStep(epic, ALICE);
		expect(listSprints(epic.id)[0].state).toBe('blocked');
		expect(getEpic(epic.id, ALICE)?.state).toBe('blocked');
		expect(db.select().from(notifications).all()[0].title).toContain('has stopped');
	});
});

describe('closing an epic', () => {
	it('finishes even though a local remote has nowhere to open a pull request', async () => {
		const { epic, sprint } = build();
		await taskReadyToGate(epic, sprint.id, [check('own', 'true')]);
		await runStep(epic, ALICE); // gate the task
		await runStep(epic, ALICE); // close the sprint

		const out = await runStep(epic, ALICE);
		expect(out.step).toBe('close-epic');
		const finished = getEpic(epic.id, ALICE);
		expect(finished?.state).toBe('done');
		// The work landed; a pull request is a convenience on top of it, and its
		// absence is recorded rather than treated as a failed build.
		expect(finished?.stateReason).toMatch(/github|pull request|remote/i);
	});
});

describe('an epic that is not running', () => {
	it('does nothing at all', async () => {
		const epic = createEpic({
			ownerId: ALICE,
			title: 'Unapproved',
			repoUrl: BARE
		});
		const out = await runStep(epic, ALICE);
		expect(out.step).toBe('none');
		expect(out.reason).toContain('drafting');
	});
});
