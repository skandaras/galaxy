import { describe, expect, it } from 'vitest';
import type { ForgeEpicState, ForgeSprintState, ForgeTaskState } from '$lib/server/db/schema';
import type { ForgeEpic, ForgeSnapshot, ForgeSprint, ForgeTask } from '$lib/server/forge';
import { nextStep } from './forge-step';

/**
 * Plain rows rather than a database: this is the point of `nextStep` being pure.
 * The ordering is where Forge is most likely to be wrong, and it should be
 * possible to be wrong about it without a container, a model or a clock.
 */
const epic = (state: ForgeEpicState = 'running'): ForgeEpic =>
	({
		id: 'e1',
		ownerId: 'alice',
		title: 'Epic',
		brief: '',
		repoUrl: 'https://example.invalid/r.git',
		repoName: 'r',
		baseBranch: 'main',
		integrationBranch: 'forge/epic-1234',
		state,
		stateReason: '',
		charterDocId: null,
		boardId: null,
		proposal: null,
		standingChecks: [],
		gateChecks: [],
		acceptance: [],
		maxUsdOverride: 0,
		createdAt: new Date(),
		approvedAt: null,
		finishedAt: null,
		lastStepAt: null
	}) as ForgeEpic;

const sprint = (id: string, position: number, state: ForgeSprintState): ForgeSprint =>
	({
		id,
		epicId: 'e1',
		position,
		title: id,
		goal: '',
		state,
		recordDocId: null,
		attempts: 0,
		createdAt: new Date(),
		startedAt: null,
		finishedAt: null
	}) as ForgeSprint;

const task = (id: string, sprintId: string, position: number, state: ForgeTaskState): ForgeTask =>
	({
		id,
		epicId: 'e1',
		sprintId,
		position,
		title: id,
		intent: '',
		acceptance: '',
		checks: [],
		noCheckReason: 'fixture',
		state,
		attempts: 0,
		chatId: null,
		branch: '',
		recordDocId: null,
		cardId: null,
		createdAt: new Date(),
		startedAt: null,
		finishedAt: null
	}) as ForgeTask;

const snap = (
	sprints: ForgeSprint[],
	tasks: ForgeTask[],
	state: ForgeEpicState = 'running'
): ForgeSnapshot => ({ epic: epic(state), sprints, tasks });

describe('an epic that is not running', () => {
	it.each([
		['drafting', 'the charter has not been written'],
		['awaiting-approval', 'a person has not frozen the checks'],
		['paused', 'somebody or a spend ceiling stopped it'],
		['blocked', 'a sprint could not pass its gate'],
		['done', 'there is nothing left'],
		['abandoned', 'it was called off']
	] as const)('yields nothing while %s, because %s', (state, _why) => {
		// A driver that "helpfully" advanced any of these would be undoing the
		// decision that put the epic there.
		expect(nextStep(snap([sprint('s1', 0, 'outlined')], [], state))).toBeNull();
	});
});

describe('what comes first', () => {
	it('finishes a sprint gate before anything else', () => {
		const s = [sprint('s1', 0, 'gating'), sprint('s2', 1, 'outlined')];
		const t = [task('t1', 's1', 0, 'planned')];
		expect(nextStep(snap(s, t))).toEqual({ kind: 'gate-sprint', sprintId: 's1' });
	});

	it('then a task gate, because the work it judges is already done', () => {
		const s = [sprint('s1', 0, 'running')];
		const t = [task('t1', 's1', 0, 'gating'), task('t2', 's1', 1, 'planned')];
		expect(nextStep(snap(s, t))).toEqual({ kind: 'gate-task', taskId: 't1' });
	});

	it('then the next planned task, in position order', () => {
		const s = [sprint('s1', 0, 'running')];
		const t = [task('t2', 's1', 1, 'planned'), task('t1', 's1', 0, 'planned')];
		expect(nextStep(snap(s, t))).toEqual({ kind: 'run-task', taskId: 't1' });
	});
});

describe('sprints in order', () => {
	it('plans an outlined sprint just in time, not up front', () => {
		// Planning sprint 4 before sprint 1 has run is planning against a repo
		// that does not exist yet.
		const s = [sprint('s1', 0, 'outlined'), sprint('s2', 1, 'outlined')];
		expect(nextStep(snap(s, []))).toEqual({ kind: 'plan-sprint', sprintId: 's1' });
	});

	it('does not start sprint 2 while sprint 1 is unfinished', () => {
		const s = [sprint('s1', 0, 'running'), sprint('s2', 1, 'outlined')];
		const t = [task('t1', 's1', 0, 'planned')];
		expect(nextStep(snap(s, t))).toEqual({ kind: 'run-task', taskId: 't1' });
	});

	it('moves to the next sprint once the first is done', () => {
		const s = [sprint('s1', 0, 'done'), sprint('s2', 1, 'outlined')];
		expect(nextStep(snap(s, [task('t1', 's1', 0, 'done')]))).toEqual({
			kind: 'plan-sprint',
			sprintId: 's2'
		});
	});

	it('closes the sprint when its tasks are all done', () => {
		const s = [sprint('s1', 0, 'running')];
		const t = [task('t1', 's1', 0, 'done'), task('t2', 's1', 1, 'done')];
		expect(nextStep(snap(s, t))).toEqual({ kind: 'close-sprint', sprintId: 's1' });
	});

	it('closes the epic when every sprint is done', () => {
		const s = [sprint('s1', 0, 'done'), sprint('s2', 1, 'done')];
		expect(nextStep(snap(s, []))).toEqual({ kind: 'close-epic' });
	});

	it('closes the epic that never had a sprint', () => {
		expect(nextStep(snap([], []))).toEqual({ kind: 'close-epic' });
	});
});

describe('work in flight', () => {
	it('still offers the next planned task while one is running', () => {
		// Deliberate: how many tasks may be in flight is `concurrentTasks`, and
		// the driver checks that before asking. Returning null here instead would
		// hard-code a concurrency of 1 into a pure function, and then the setting
		// could never mean anything above it.
		const s = [sprint('s1', 0, 'running')];
		const t = [task('t1', 's1', 0, 'running'), task('t2', 's1', 1, 'planned')];
		expect(nextStep(snap(s, t))).toEqual({ kind: 'run-task', taskId: 't2' });
	});

	it('does not close a sprint while one of its tasks is still running', () => {
		const s = [sprint('s1', 0, 'running')];
		const t = [task('t1', 's1', 0, 'running'), task('t2', 's1', 1, 'done')];
		expect(nextStep(snap(s, t))).toBeNull();
	});

	it('starts nothing while a sprint is being planned', () => {
		expect(nextStep(snap([sprint('s1', 0, 'planning')], []))).toBeNull();
	});
});

describe('a blocked task', () => {
	it('does not stall the tasks after it', () => {
		// One task nobody could finish must not stop an epic that has thirty
		// others it could be getting on with.
		const s = [sprint('s1', 0, 'running')];
		const t = [task('t1', 's1', 0, 'blocked'), task('t2', 's1', 1, 'planned')];
		expect(nextStep(snap(s, t))).toEqual({ kind: 'run-task', taskId: 't2' });
	});

	it('does stop its sprint closing', () => {
		// A sprint with work nobody could finish has not met its goal, whatever
		// the gate would say about the code that did land.
		const s = [sprint('s1', 0, 'running')];
		const t = [task('t1', 's1', 0, 'blocked'), task('t2', 's1', 1, 'done')];
		expect(nextStep(snap(s, t))).toBeNull();
	});

	it('leaves the epic stuck rather than skipping to the next sprint', () => {
		const s = [sprint('s1', 0, 'running'), sprint('s2', 1, 'outlined')];
		const t = [task('t1', 's1', 0, 'blocked')];
		expect(nextStep(snap(s, t))).toBeNull();
	});
});

describe('tasks of other sprints', () => {
	it('are not run out of turn', () => {
		const s = [sprint('s1', 0, 'running'), sprint('s2', 1, 'outlined')];
		const t = [task('t1', 's1', 0, 'done'), task('t2', 's2', 0, 'planned')];
		// s2's task exists but s2 has not been planned or started, so closing s1
		// is what comes next.
		expect(nextStep(snap(s, t))).toEqual({ kind: 'close-sprint', sprintId: 's1' });
	});
});
