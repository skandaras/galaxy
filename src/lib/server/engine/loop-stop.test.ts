import { beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '$lib/server/db';
import type { ModelChoice } from '$lib/server/providers/registry';
import type { ChatRequest, StreamEvent, ToolCall } from '$lib/server/providers/types';
import { cancelJob, createJob, type JobChunk } from './jobs';
import { runAgentLoop, type LoopTool, type TurnSummary } from './loop';

beforeAll(() => {
	runMigrations();
});

/**
 * A model that asks for `toolRounds` tool calls and then answers — unless
 * `neverStops`, which keeps calling forever the way a task too big for the
 * step budget does.
 */
function scriptedChoice(opts: { toolRounds: number; neverStops?: boolean }): ModelChoice {
	let round = 0;
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
			async *stream(_req: ChatRequest): AsyncGenerator<StreamEvent> {
				const call: ToolCall = {
					id: `c${round}`,
					name: 'read_file',
					arguments: JSON.stringify({ path: `file${round}.ts` })
				};
				if (opts.neverStops || round < opts.toolRounds) {
					round++;
					yield { type: 'tool_calls', calls: [call] };
				} else {
					yield { type: 'text', delta: 'All done.' };
				}
				yield { type: 'done', finishReason: 'stop' };
			},
			complete: async () => ({ text: '', usage: null }),
			listModels: async () => []
		}
	} as unknown as ModelChoice;
}

const readTool: LoopTool = {
	def: { name: 'read_file', description: 'read', parameters: {} },
	describe: (a) => String(a.path ?? ''),
	// A real tool call takes time; without that the loop can burn its whole step
	// budget before a cancellation timer ever fires.
	execute: async () => {
		await new Promise((r) => setTimeout(r, 2));
		return 'file contents';
	}
};

async function run(opts: {
	choice: ModelChoice;
	maxIterations: number;
	budgetBlocked?: () => boolean;
	cancelAfterMs?: number;
}): Promise<{ summary: TurnSummary | null; chunks: JobChunk[] }> {
	const job = createJob({ chatId: 'c1', userId: 'u1', task: 'coding', persist: false });
	const chunks: JobChunk[] = [];
	job.subscribers.add((c) => chunks.push(c));
	let summary: TurnSummary | null = null;
	if (opts.cancelAfterMs !== undefined) setTimeout(() => cancelJob(job), opts.cancelAfterMs);
	await runAgentLoop({
		job,
		task: 'coding',
		userId: 'u1',
		chatId: 'c1',
		persist: false,
		primary: opts.choice,
		backup: null,
		tools: [readTool],
		maxIterations: opts.maxIterations,
		budgetBlocked: opts.budgetBlocked,
		buildMessages: () => [],
		onDone: (_t, _u, _c, s) => {
			summary = s;
		}
	});
	return { summary, chunks };
}

describe('turn stop reasons', () => {
	it('reports a turn that finished on its own', async () => {
		const { summary } = await run({ choice: scriptedChoice({ toolRounds: 2 }), maxIterations: 20 });
		expect(summary?.stopReason).toBe('complete');
		expect(summary?.steps).toBe(3); // two tool rounds plus the closing answer
	});

	it('reports a turn cut off by the step budget', async () => {
		// This is the case that used to look identical to success: the loop just
		// stopped mid-task with status ok and nothing said.
		const { summary } = await run({
			choice: scriptedChoice({ toolRounds: 0, neverStops: true }),
			maxIterations: 4
		});
		expect(summary?.stopReason).toBe('exhausted');
		expect(summary?.steps).toBe(4);
	});

	it('records the tool calls made, with their targets', async () => {
		const { summary } = await run({ choice: scriptedChoice({ toolRounds: 2 }), maxIterations: 20 });
		expect(summary?.toolCalls).toEqual([
			{ name: 'read_file', summary: 'file0.ts' },
			{ name: 'read_file', summary: 'file1.ts' }
		]);
	});

	it('stops when the budget runs out mid-run, and says so', async () => {
		// assertBudget only guards the start of a turn, so a long run has to keep
		// checking or it sails past the cap.
		let calls = 0;
		const { summary, chunks } = await run({
			choice: scriptedChoice({ toolRounds: 0, neverStops: true }),
			maxIterations: 50,
			budgetBlocked: () => ++calls > 1
		});
		expect(summary?.stopReason).toBe('budget');
		expect(summary?.steps).toBeLessThan(50);
		expect(chunks.some((c) => c.type === 'notice' && c.text.includes('spend cap'))).toBe(true);
	});

	it('reports a user stop as cancelled, not as finishing', async () => {
		const { summary } = await run({
			choice: scriptedChoice({ toolRounds: 0, neverStops: true }),
			maxIterations: 50,
			cancelAfterMs: 5
		});
		expect(summary?.stopReason).toBe('cancelled');
	});
});
