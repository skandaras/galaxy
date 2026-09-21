import { describe, expect, it } from 'vitest';
import type { ForgeCheckResult } from '$lib/server/db/schema';
import {
	ago,
	checksInReadingOrder,
	duration,
	epicProgress,
	epicTone,
	gateSummary,
	progress,
	say,
	sprintsInOrder,
	taskTone,
	type GateView,
	type SprintView,
	type TaskView
} from './forge-view';

/**
 * The arithmetic and the ordering the page draws from.
 *
 * All of it is the quietly-wrong sort: a percentage that counts a parked task
 * as progress reads as a build that finished, and a gate that lists its failing
 * check third makes somebody read past the only thing they opened it for.
 */

const task = (id: string, state: TaskView['state'], position = 0): TaskView => ({
	id,
	title: id,
	state,
	attempts: 0,
	position,
	sprintId: 's1'
});

const check = (name: string, exitCode: number, extra: Partial<ForgeCheckResult> = {}) => ({
	name,
	command: `run ${name}`,
	exitCode,
	durationMs: 1000,
	output: '',
	timedOut: false,
	...extra
});

const gate = (results: ForgeCheckResult[], passed = false): GateView => ({
	id: 'g1',
	scope: 'task',
	attempt: 1,
	baseline: false,
	passed,
	createdAt: Date.now(),
	results
});

describe('progress', () => {
	it('is done over total, and a parked task is neither', () => {
		// Counting blocked as progress would let a sprint where nothing worked
		// read as finished.
		const p = progress([
			task('a', 'done'),
			task('b', 'done'),
			task('c', 'blocked'),
			task('d', 'planned')
		]);
		expect(p).toMatchObject({ total: 4, done: 2, blocked: 1, percent: 50 });
	});

	it('does not let the bar jump backwards when a task parks', () => {
		// Which is what dropping blocked tasks out of `total` would do.
		const before = progress([task('a', 'done'), task('b', 'running')]);
		const after = progress([task('a', 'done'), task('b', 'blocked')]);
		expect(after.percent).toBe(before.percent);
	});

	it('counts a task being checked as still running', () => {
		expect(progress([task('a', 'gating'), task('b', 'running')]).running).toBe(2);
	});

	it('is zero rather than NaN for a sprint with no tasks yet', () => {
		expect(progress([])).toMatchObject({ total: 0, percent: 0 });
	});

	it('adds up across the whole tree', () => {
		const sprints: SprintView[] = [
			{
				id: 's1',
				title: 'One',
				goal: '',
				state: 'done',
				position: 0,
				tasks: [task('a', 'done'), task('b', 'done')]
			},
			{
				id: 's2',
				title: 'Two',
				goal: '',
				state: 'running',
				position: 1,
				tasks: [task('c', 'done'), task('d', 'planned')]
			}
		];
		expect(epicProgress(sprints)).toMatchObject({ total: 4, done: 3, percent: 75 });
	});
});

describe('the tree', () => {
	it('reads in the order the work runs, whatever order it arrived in', () => {
		// Position is the dependency — sprint N+1 cannot start until N is done —
		// so it is also the only order that reads correctly.
		const sprints: SprintView[] = [
			{
				id: 's2',
				title: 'Two',
				goal: '',
				state: 'outlined',
				position: 1,
				tasks: [task('d', 'planned', 1), task('c', 'planned', 0)]
			},
			{ id: 's1', title: 'One', goal: '', state: 'done', position: 0, tasks: [] }
		];
		const ordered = sprintsInOrder(sprints);
		expect(ordered.map((s) => s.title)).toEqual(['One', 'Two']);
		expect(ordered[1].tasks.map((t) => t.id)).toEqual(['c', 'd']);
	});

	it('does not reorder the caller’s own array', () => {
		const sprints: SprintView[] = [
			{ id: 's2', title: 'Two', goal: '', state: 'outlined', position: 1, tasks: [] },
			{ id: 's1', title: 'One', goal: '', state: 'done', position: 0, tasks: [] }
		];
		sprintsInOrder(sprints);
		expect(sprints.map((s) => s.id)).toEqual(['s2', 's1']);
	});
});

describe('a gate’s checks', () => {
	it('put the failure first, because that is the only thing anybody opened it for', () => {
		const ordered = checksInReadingOrder(
			gate([check('lint', 0), check('test', 1), check('build', 0)])
		);
		expect(ordered.map((r) => r.name)).toEqual(['test', 'lint', 'build']);
	});

	it('keep the order the gate ran them in within each group', () => {
		const ordered = checksInReadingOrder(
			gate([check('a', 0), check('b', 2), check('c', 0), check('d', 1)])
		);
		expect(ordered.map((r) => r.name)).toEqual(['b', 'd', 'a', 'c']);
	});

	it('are empty rather than broken when there is no gate at all', () => {
		expect(checksInReadingOrder(null)).toEqual([]);
		expect(checksInReadingOrder({ ...gate([]), results: null })).toEqual([]);
	});
});

describe('what a gate says in one line', () => {
	it('counts what passed', () => {
		expect(gateSummary(gate([check('a', 0), check('b', 1), check('c', 0)]))).toBe(
			'2 of 3 checks passed'
		);
	});

	it('says so when a check ran out of time, which is not the same as failing', () => {
		expect(gateSummary(gate([check('a', 0), check('slow', 124, { timedOut: true })]))).toContain(
			'1 timed out'
		);
	});

	it('gets the singular right', () => {
		expect(gateSummary(gate([check('a', 0)], true))).toBe('1 of 1 check passed');
	});

	it('distinguishes never-ran from no-checks', () => {
		expect(gateSummary(null)).toBe('no gate has run yet');
		expect(gateSummary(gate([], false))).toBe('failed before any check ran');
	});
});

describe('durations', () => {
	it('are read in whatever unit a person thinks in', () => {
		expect(duration(400)).toBe('400ms');
		expect(duration(2_400)).toBe('2.4s');
		expect(duration(42_000)).toBe('42s');
		expect(duration(184_000)).toBe('3m 4s');
	});

	it('say nothing rather than something wrong', () => {
		expect(duration(Number.NaN)).toBe('');
		expect(duration(-1)).toBe('');
	});
});

describe('relative time', () => {
	const NOW = Date.UTC(2026, 8, 20, 12, 0);
	it('reads at every scale', () => {
		expect(ago(NOW - 20_000, NOW)).toBe('just now');
		expect(ago(NOW - 5 * 60_000, NOW)).toBe('5m ago');
		expect(ago(NOW - 3 * 3_600_000, NOW)).toBe('3h ago');
		expect(ago(NOW - 4 * 86_400_000, NOW)).toBe('4d ago');
	});

	it('says nothing for a timestamp that is not one', () => {
		// A stale tab mid-deploy can still be holding ISO strings, which is what
		// used to produce "NaNd" in the bell.
		expect(ago(null, NOW)).toBe('');
		expect(ago(undefined, NOW)).toBe('');
		expect(ago(Number.NaN, NOW)).toBe('');
	});
});

describe('how a state is said out loud', () => {
	it('translates the ones the stored word would mislead on', () => {
		expect(say('awaiting-approval')).toBe('waiting for you');
		expect(say('gating')).toBe('being checked');
		expect(say('outlined')).toBe('not planned yet');
	});

	it('leaves the ones that already read correctly', () => {
		expect(say('running')).toBe('running');
		expect(say('done')).toBe('done');
	});

	it('gives a stopped thing the tone that gets looked at', () => {
		expect(epicTone('blocked')).toBe('warn');
		expect(epicTone('awaiting-approval')).toBe('warn');
		expect(epicTone('running')).toBe('good');
		expect(epicTone('paused')).toBe('idle');
		expect(taskTone('blocked')).toBe('warn');
		expect(taskTone('planned')).toBe('idle');
	});
});
