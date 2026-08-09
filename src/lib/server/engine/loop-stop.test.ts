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
 * step budget does. `narrate` makes it write a line before each batch, which is
 * what the prompt asks a real model for and what step labels are built from.
 */
function scriptedChoice(opts: {
	toolRounds: number;
	neverStops?: boolean;
	narrate?: boolean;
	/** Answers with nothing at all — a real empty reply, not a cut-short leg. */
	silent?: boolean;
}): ModelChoice {
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
					if (opts.narrate) yield { type: 'text', delta: `Reading file${round}.` };
					round++;
					yield { type: 'tool_calls', calls: [call] };
				} else if (!opts.silent) {
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
}): Promise<{ summary: TurnSummary | null; chunks: JobChunk[]; text: string | null }> {
	const job = createJob({ chatId: 'c1', userId: 'u1', task: 'coding', persist: false });
	const chunks: JobChunk[] = [];
	job.subscribers.add((c) => chunks.push(c));
	let summary: TurnSummary | null = null;
	// What onDone would persist as the assistant message.
	let text: string | null = null;
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
		onDone: (t, _u, _c, s) => {
			summary = s;
			text = t;
		}
	});
	return { summary, chunks, text };
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

/**
 * Narration written before a batch of tool calls labels that step instead of
 * being appended to the reply — which is what used to glue a model's running
 * commentary to its final answer as one blob.
 */
describe('narration becomes a step label, not the reply', () => {
	it('keeps mid-turn narration out of the saved message', async () => {
		const { text } = await run({
			choice: scriptedChoice({ toolRounds: 2, narrate: true }),
			maxIterations: 20
		});
		// Both rounds narrated; only the closing, tool-less answer is the reply.
		expect(text).toBe('All done.');
		expect(text).not.toContain('Reading file');
	});

	it('never saves an empty message when the step cap cuts a leg short', async () => {
		// The regression this guards: the last iteration ended on tool calls, so
		// its text became a label and there was nothing left for the reply.
		const { text, summary } = await run({
			choice: scriptedChoice({ toolRounds: 0, neverStops: true, narrate: true }),
			maxIterations: 3
		});
		expect(summary?.stopReason).toBe('exhausted');
		expect(text?.trim()).not.toBe('');
		expect(text).toContain('Ran out of steps');
		expect(text).toContain('Reading file2.');
	});

	it('never saves an empty message when the user stops a leg', async () => {
		const { text, summary } = await run({
			choice: scriptedChoice({ toolRounds: 0, neverStops: true, narrate: true }),
			maxIterations: 50,
			cancelAfterMs: 5
		});
		expect(summary?.stopReason).toBe('cancelled');
		expect(text?.trim()).not.toBe('');
		expect(text).toContain('Stopped before finishing');
	});

	it('still keeps a partial reply the user interrupted mid-stream', async () => {
		// The other half of the rule: text cut off while it was streaming *is*
		// the reply, and must not be replaced by the fallback.
		const choice = {
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
				async *stream(_req: ChatRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
					yield { type: 'text', delta: 'Half an answ' };
					await new Promise((_, reject) => {
						signal?.addEventListener('abort', () => reject(signal.reason));
					});
				},
				complete: async () => ({ text: '', usage: null }),
				listModels: async () => []
			}
		} as unknown as ModelChoice;

		const { summary, text } = await run({ choice, maxIterations: 5, cancelAfterMs: 10 });
		expect(summary?.stopReason).toBe('cancelled');
		expect(text).toBe('Half an answ');
	});

	it('falls back to the tool call when the model narrates nothing', async () => {
		const { text } = await run({
			choice: scriptedChoice({ toolRounds: 0, neverStops: true }),
			maxIterations: 2
		});
		expect(text).toContain('read_file file1.ts');
	});

	it('leaves a genuinely empty answer empty, so run-history still spots it', async () => {
		// A turn that called nothing and returned nothing is a real empty reply;
		// dressing it up would hide it from previousRunNote's lastReplyWasEmpty.
		const { text } = await run({
			choice: scriptedChoice({ toolRounds: 0, silent: true }),
			maxIterations: 20
		});
		expect(text).toBe('');
	});
});
