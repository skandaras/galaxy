import { beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '$lib/server/db';
import type { TurnSummary } from './loop';
import { cleanSummary, formatLegForSummary, summariseLeg, withDeadline } from './run-summary';

beforeAll(() => {
	runMigrations();
});

const leg = (patch: Partial<TurnSummary> = {}): TurnSummary => ({
	stopReason: 'complete',
	steps: 3,
	toolCalls: [
		{ name: 'read_file', summary: 'src/lib/loop.ts' },
		{ name: 'edit_file', summary: 'src/lib/loop.ts' }
	],
	trace: [],
	fallbackReply: false,
	...patch
});

describe('formatLegForSummary', () => {
	it('describes the leg from its tool calls, never a transcript', () => {
		const text = formatLegForSummary(leg());
		expect(text).toContain('read_file: src/lib/loop.ts');
		expect(text).toContain('edit_file: src/lib/loop.ts');
		expect(text).toContain('3 model steps');
	});

	it('says how the leg ended in words, not a status code', () => {
		expect(formatLegForSummary(leg({ stopReason: 'exhausted' }))).toContain('ran out of steps');
		expect(formatLegForSummary(leg({ stopReason: 'cancelled' }))).toContain('the user stopped it');
		expect(formatLegForSummary(leg({ stopReason: 'budget' }))).toContain('spend cap');
	});

	it('trims a long leg to its most recent calls', () => {
		const many = Array.from({ length: 80 }, (_, i) => ({ name: 'bash', summary: `cmd${i}` }));
		const text = formatLegForSummary(leg({ toolCalls: many }));
		expect(text).toContain('50 earlier calls omitted');
		expect(text).toContain('cmd79');
		expect(text).not.toContain('cmd0\n');
	});

	it('copes with a leg that called nothing', () => {
		expect(formatLegForSummary(leg({ toolCalls: [] }))).toContain('no tools were called');
	});
});

describe('cleanSummary', () => {
	it('strips the decorations models add to "one line, no preamble"', () => {
		expect(cleanSummary('"Added retry handling to fetch-url."')).toBe(
			'Added retry handling to fetch-url'
		);
		expect(cleanSummary('Summary: Ran the unit tests')).toBe('Ran the unit tests');
		// Bold goes too: this ends up in a commit message, which renders none of it.
		expect(cleanSummary('- **Fixed the loop**')).toBe('Fixed the loop');
	});

	it('unwraps nested decorations, which is the common shape', () => {
		expect(cleanSummary('"Summary: Fixed the loop"')).toBe('Fixed the loop');
	});

	it('takes only the first non-empty line', () => {
		expect(cleanSummary('\n\nFixed the loop\nThen ran the tests')).toBe('Fixed the loop');
	});

	it('returns empty for nothing usable, so the caller can fall back', () => {
		expect(cleanSummary('')).toBe('');
		expect(cleanSummary('   \n  ')).toBe('');
	});
});

describe('withDeadline', () => {
	it('returns the value when it arrives in time', async () => {
		await expect(withDeadline(Promise.resolve('done'), 50)).resolves.toBe('done');
	});

	it('gives up rather than holding the run open', async () => {
		const slow = new Promise<string>((r) => setTimeout(() => r('too late'), 200).unref?.());
		await expect(withDeadline(slow, 20)).resolves.toBeNull();
	});
});

describe('summariseLeg', () => {
	it('degrades to null when no model is configured, rather than throwing', async () => {
		// The whole contract: a run must never fail because the thing that names
		// it could not run. No providers exist in the test database.
		await expect(
			summariseLeg({ chatId: 'c1', userId: 'u1', persist: false, summary: leg() })
		).resolves.toBeNull();
	});
});
