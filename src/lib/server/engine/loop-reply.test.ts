import { beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '$lib/server/db';
import type { ModelChoice } from '$lib/server/providers/registry';
import type { StreamEvent, ToolCall } from '$lib/server/providers/types';
import { createJob, type JobChunk } from './jobs';
import { runAgentLoop, type LoopTool, type TurnSummary } from './loop';

/**
 * How a run's legs become one reply.
 *
 * The defect this covers: every leg whose text was kept got appended straight
 * onto the last, so one leg's closing full stop ran into the next leg's opening
 * capital — "…convert correctly.Now the remaining shapes I need" — and a run
 * that narrated across several legs arrived as an unbroken wall.
 */

beforeAll(() => {
	runMigrations();
});

const READ: ToolCall = { id: 'c1', name: 'read_file', arguments: '{"path":"a.ts"}' };

/** A model that plays out one scripted leg per turn. */
type Leg = { text: string; calls?: ToolCall[] };

function scripted(legs: Leg[]): ModelChoice {
	let i = 0;
	return {
		model: {
			modelKey: 'mock',
			displayName: 'Mock',
			supportsTools: true,
			supportsVision: false,
			promptCostPerMTok: null,
			completionCostPerMTok: null
		},
		provider: {},
		adapter: {
			async *stream(): AsyncGenerator<StreamEvent> {
				const leg = legs[Math.min(i++, legs.length - 1)];
				if (leg.text) yield { type: 'text', delta: leg.text };
				if (leg.calls?.length) yield { type: 'tool_calls', calls: leg.calls };
				yield { type: 'done', finishReason: leg.calls?.length ? 'tool_calls' : 'stop' };
			},
			complete: async () => ({ text: '', usage: null }),
			listModels: async () => []
		}
	} as unknown as ModelChoice;
}

const readFile: LoopTool = {
	def: { name: 'read_file', description: 'read', parameters: {} },
	describe: (a) => String(a.path ?? ''),
	execute: async () => 'contents'
};

async function run(legs: Leg[]): Promise<{ reply: string; chunks: JobChunk[] }> {
	const job = createJob({ chatId: `reply-${Math.random()}`, userId: 'u1', task: 'coding', persist: false });
	const chunks: JobChunk[] = [];
	job.subscribers.add((c) => chunks.push(c));
	let reply = '';
	await runAgentLoop({
		job,
		task: 'coding',
		userId: 'u1',
		chatId: job.chatId,
		persist: false,
		primary: scripted(legs),
		backup: null,
		tools: [readFile],
		maxIterations: 6,
		buildMessages: () => [{ role: 'system', content: 'You are a test agent.' }],
		onDone: (text: string, _u: unknown, _c: unknown, _s: TurnSummary) => {
			reply = text;
			return 'msg-1';
		}
	});
	return { reply, chunks };
}

/** A lead-in past the old 200-character line, which now becomes a step. */
const LONG_LEAD_IN =
	'Now the remaining shapes I need: the player store I extended last session, the ' +
	'option units, how the rack invokes controls, the revisions API for the history ' +
	'panel, and where lyrics would slot into the renderer.';

/** Long enough to be writing rather than a lead-in, and so kept in the reply. */
const KEPT = `Here is the draft you asked for.\n${'z'.repeat(1_600)}`;

describe('assembling the reply from a run', () => {
	it('puts a blank line between legs rather than running them together', async () => {
		const { reply } = await run([
			{ text: 'The first thing I found converts correctly.', calls: [READ] },
			{ text: KEPT, calls: [READ] },
			{ text: 'And that is the lot.' }
		]);
		expect(reply).not.toContain('correctly.Here');
		expect(reply.split('\n\n')).toHaveLength(2);
		expect(reply.startsWith('Here is the draft')).toBe(true);
		expect(reply.endsWith('And that is the lot.')).toBe(true);
	});

	it('leaves a long lead-in out of the reply and on its step', async () => {
		const { reply, chunks } = await run([
			{ text: LONG_LEAD_IN, calls: [READ] },
			{ text: 'Done.' }
		]);
		expect(reply).toBe('Done.');
		const step = chunks.find((c) => c.type === 'step');
		expect(step).toMatchObject({ consumedText: true, note: LONG_LEAD_IN });
		// The label is the glance; the note is the substance.
		expect((step as { label: string }).label.length).toBeLessThanOrEqual(100);
	});

	it('keeps writing in the reply and gives its step no note', async () => {
		const { reply, chunks } = await run([{ text: KEPT, calls: [READ] }, { text: 'Done.' }]);
		expect(reply.startsWith('Here is the draft')).toBe(true);
		const step = chunks.find((c) => c.type === 'step') as { consumedText: boolean; note?: string };
		expect(step.consumedText).toBe(false);
		expect(step.note).toBeUndefined();
	});

	it('has no stray blank lines when every leg was a lead-in', async () => {
		const { reply } = await run([
			{ text: LONG_LEAD_IN, calls: [READ] },
			{ text: 'Checking the second file now.', calls: [READ] },
			{ text: 'All done.' }
		]);
		expect(reply).toBe('All done.');
	});
});
