import { beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '$lib/server/db';
import type { ModelChoice } from '$lib/server/providers/registry';
import type { ChatRequest, StreamEvent, ToolCall } from '$lib/server/providers/types';
import {
	applyChunk,
	isTimelineChunk,
	type TimelineChunk,
	type TimelineItem
} from '$lib/run-timeline';
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
	tools?: LoopTool[];
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
		tools: opts.tools ?? [readTool],
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
			{ name: 'read_file', summary: 'file0.ts', status: 'ok' },
			{ name: 'read_file', summary: 'file1.ts', status: 'ok' }
		]);
	});

	it('groups those same calls under the step that made them', async () => {
		const { summary } = await run({ choice: scriptedChoice({ toolRounds: 2 }), maxIterations: 20 });
		expect(summary?.trace).toHaveLength(2);
		// One set of facts, two views of it — the grouped record must be the very
		// object in the flat list, not a copy that can drift from it.
		expect(summary?.trace[0].toolCalls[0]).toBe(summary?.toolCalls[0]);
		expect(summary?.trace.flatMap((s) => s.toolCalls)).toEqual(summary?.toolCalls);
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

describe('step chunks', () => {
	const steps = (chunks: JobChunk[]) => chunks.filter((c) => c.type === 'step');
	const tools = (chunks: JobChunk[]) => chunks.filter((c) => c.type === 'tool');

	it('opens and closes one step per tool-calling round-trip', async () => {
		const { chunks } = await run({
			choice: scriptedChoice({ toolRounds: 2, narrate: true }),
			maxIterations: 20
		});
		const emitted = steps(chunks);
		// Two tool rounds; the closing answer is the reply, not a step.
		expect(emitted).toHaveLength(4);
		expect(emitted.map((s) => s.status)).toEqual(['running', 'ok', 'running', 'ok']);
		expect(emitted[0].label).toBe('Reading file0.');
		// A step keeps its id from open to close, which is what makes replay
		// converge instead of duplicating the row.
		expect(emitted[0].id).toBe(emitted[1].id);
		expect(emitted[0].id).not.toBe(emitted[2].id);
	});

	it('nests each tool call under its step, with the provider call id', async () => {
		const { chunks } = await run({ choice: scriptedChoice({ toolRounds: 1 }), maxIterations: 20 });
		const step = steps(chunks)[0];
		for (const t of tools(chunks)) {
			expect(t.stepId).toBe(step.id);
			// Name-matching mispairs the moment two calls to one tool overlap.
			expect(t.callId).toBe('c0');
		}
	});

	it('replays into the same timeline a live client built', async () => {
		// The real cold-replay path: subscribeJob hands a reconnecting client the
		// job's entire chunk history, so folding it twice from empty has to land
		// exactly where folding it once did.
		const { chunks } = await run({
			choice: scriptedChoice({ toolRounds: 3, narrate: true }),
			maxIterations: 20
		});
		const timeline = chunks.filter(isTimelineChunk);
		const fold = (cs: TimelineChunk[]) =>
			cs.reduce<TimelineItem[]>((items, c) => applyChunk(items, c), []);

		const live = fold(timeline);
		expect(fold([...timeline, ...timeline])).toEqual(live);
		expect(live.filter((i) => i.kind === 'step')).toHaveLength(3);
	});

	it('keeps type, name and status adjacent on the wire', async () => {
		// scripts/smoke-e2e.sh — the gate that decides whether an image is cut —
		// matches raw SSE text for `"type":"tool","name":"…","status":"ok"`.
		// Putting a new field between them breaks seven of its assertions at
		// once, and nothing else here would notice.
		const { chunks } = await run({ choice: scriptedChoice({ toolRounds: 1 }), maxIterations: 20 });
		const done = chunks.find((c) => c.type === 'tool' && c.status === 'ok');
		expect(JSON.stringify(done)).toContain('"type":"tool","name":"read_file","status":"ok"');
	});

	it('marks a step failed when a call inside it fails', async () => {
		const failing: LoopTool = {
			def: { name: 'read_file', description: 'read', parameters: {} },
			describe: (a) => String(a.path ?? ''),
			execute: async () => {
				throw new Error('no such file');
			}
		};
		const { chunks, summary } = await run({
			choice: scriptedChoice({ toolRounds: 1 }),
			maxIterations: 20,
			tools: [failing]
		});
		expect(steps(chunks).at(-1)?.status).toBe('error');
		expect(summary?.trace[0].status).toBe('error');
		expect(summary?.toolCalls[0].status).toBe('error');
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

	it('keeps writing the model did for the user, even before a tool call', async () => {
		// The reported regression: asked to redraft an email, the model wrote the
		// new draft and called a tool in the same message. The draft became a
		// 100-character step label and the user was left with a reply that only
		// said the work had been done.
		const EMAIL = [
			'Hi Sam,',
			'',
			'Thanks for the proposal. The scope looks right, but the timeline needs',
			'another two weeks.',
			'',
			'Best,',
			'Alex'
		].join('\n');
		let round = 0;
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
				async *stream(): AsyncGenerator<StreamEvent> {
					if (round++ === 0) {
						yield { type: 'text', delta: EMAIL };
						yield {
							type: 'tool_calls',
							calls: [
								{ id: 'c0', name: 'read_file', arguments: JSON.stringify({ path: 'notes.md' }) }
							]
						};
					} else {
						yield { type: 'text', delta: "\n\nI've saved that as the new draft." };
					}
					yield { type: 'done', finishReason: 'stop' };
				},
				complete: async () => ({ text: '', usage: null }),
				listModels: async () => []
			}
		} as unknown as ModelChoice;

		const { text, chunks, summary } = await run({ choice, maxIterations: 10 });
		expect(text).toContain('Thanks for the proposal');
		expect(text).toContain('Best,');
		expect(text).toContain("I've saved that as the new draft.");
		// The step is named after what it called, not after a line of the email.
		expect(summary?.trace[0].label).toBe('read_file notes.md');
		// ...and the browser is told to keep what it has buffered.
		const step = chunks.find((c) => c.type === 'step');
		expect(step && 'consumedText' in step && step.consumedText).toBe(false);
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
