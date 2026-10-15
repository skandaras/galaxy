import { describe, expect, it } from 'vitest';
import {
	CONTEXT_HIGH_PERCENT,
	contextShare,
	formatElapsed,
	mergeOutputs,
	planProgress,
	prNumber,
	refreshesOverview
} from './session-panel';
import type { TimelineItem } from './run-timeline';

describe('formatElapsed', () => {
	it('formats seconds, minute rollover, and hours', () => {
		expect(formatElapsed(0, 12_000)).toBe('0m 12s');
		expect(formatElapsed(0, 60_000)).toBe('1m 00s');
		expect(formatElapsed(0, 3_840_000)).toBe('1h 04m');
	});

	it('never shows negative elapsed time', () => {
		expect(formatElapsed(10_000, 0)).toBe('0m 00s');
	});
});

describe('contextShare', () => {
	it('handles missing and zero windows', () => {
		expect(contextShare(10, null)).toEqual({ percent: null, high: false });
		expect(contextShare(10, 0)).toEqual({ percent: null, high: false });
	});

	it('rounds the share, caps it at 100, and marks the high threshold', () => {
		expect(contextShare(1, 3)).toEqual({ percent: 33, high: false });
		expect(contextShare(CONTEXT_HIGH_PERCENT, 100)).toEqual({ percent: 80, high: true });
		expect(contextShare(101, 100)).toEqual({ percent: 100, high: true });
	});
});

describe('mergeOutputs', () => {
	it('keeps stored paths first and adds only successful writes, once each', () => {
		const timeline: TimelineItem[] = [
			{
				kind: 'step',
				id: 's1',
				label: 'Writing',
				status: 'ok',
				tools: [
					{ name: 'write_file', status: 'ok', detail: 'src/new.ts' },
					{ name: 'edit_file', status: 'ok', detail: 'src/existing.ts' },
					{ name: 'edit_file', status: 'ok', detail: 'src/existing.ts' },
					{ name: 'write_file', status: 'error', detail: 'src/failed.ts' },
					{ name: 'write_file', status: 'running', detail: 'src/running.ts' },
					{ name: 'read_file', status: 'ok', detail: 'src/read.ts' }
				]
			},
			{ kind: 'notice', text: 'done' }
		];
		expect(mergeOutputs(['src/stored.ts', 'src/new.ts'], timeline)).toEqual([
			'src/stored.ts',
			'src/new.ts',
			'src/existing.ts'
		]);
	});
});

describe('prNumber and planProgress', () => {
	it('extracts a pull request number when present', () => {
		expect(prNumber('https://github.com/o/r/pull/42')).toBe(42);
		expect(prNumber(null)).toBeNull();
		expect(prNumber('https://github.com/o/r/issues/42')).toBeNull();
	});

	it('counts completed plan entries', () => {
		expect(
			planProgress([
				{ text: 'one', status: 'done' },
				{ text: 'two', status: 'doing' },
				{ text: 'three', status: 'todo' }
			])
		).toBe('1/3');
		expect(planProgress([])).toBe('0/0');
	});
});

describe('refreshesOverview', () => {
	it('refreshes after a settled step, and not while it is running', () => {
		expect(refreshesOverview({ type: 'step', status: 'ok' })).toBe(true);
		expect(refreshesOverview({ type: 'step', status: 'error' })).toBe(true);
		expect(refreshesOverview({ type: 'step', status: 'running' })).toBe(false);
	});

	it('refreshes after settled overview tools only', () => {
		for (const name of ['update_plan', 'git_commit', 'git_push', 'open_pull_request']) {
			expect(refreshesOverview({ type: 'tool', name, status: 'ok' })).toBe(true);
			expect(refreshesOverview({ type: 'tool', name, status: 'error' })).toBe(true);
			expect(refreshesOverview({ type: 'tool', name, status: 'running' })).toBe(false);
		}
		expect(refreshesOverview({ type: 'tool', name: 'read_file', status: 'ok' })).toBe(false);
	});

	it('ignores other chunk types, even when settled', () => {
		expect(refreshesOverview({ type: 'notice', status: 'ok' })).toBe(false);
		expect(refreshesOverview({ type: 'stage', status: 'error' })).toBe(false);
		expect(refreshesOverview({ type: 'tool', name: 'git_push' })).toBe(false);
	});
});
