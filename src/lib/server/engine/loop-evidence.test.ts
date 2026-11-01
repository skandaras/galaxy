import { beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '$lib/server/db';
import type { ModelChoice } from '$lib/server/providers/registry';
import type { ChatRequest, StreamEvent } from '$lib/server/providers/types';
import { createJob } from './jobs';
import { runAgentLoop, type LoopTool, type TurnSummary } from './loop';

/**
 * Which tool results a turn hands on as evidence. Only successful calls, never
 * a tool whose arguments describe a person, and a hook that breaks costs only
 * itself.
 */

beforeAll(() => {
	runMigrations();
});

/** Calls every tool it is offered once, in one batch, then answers. */
function callingChoice(): ModelChoice {
	return {
		model: {
			id: 'row',
			modelKey: 'mock',
			displayName: 'Mock',
			supportsTools: true,
			supportsVision: false,
			supportsReasoning: false,
			reasoningMode: 'auto',
			promptCostPerMTok: null,
			completionCostPerMTok: null
		},
		provider: {},
		adapter: {
			async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
				if (req.messages.some((m) => m.role === 'tool')) {
					yield { type: 'text', delta: 'Done.' };
				} else {
					yield {
						type: 'tool_calls',
						calls: (req.tools ?? []).map((t, i) => ({ id: `c${i}`, name: t.name, arguments: '{}' }))
					};
				}
				yield { type: 'done', finishReason: 'stop' };
			},
			complete: async () => ({ text: '', usage: null }),
			listModels: async () => []
		}
	} as unknown as ModelChoice;
}

const tool = (name: string, extra: Partial<LoopTool>): LoopTool => ({
	def: { name, description: name, parameters: { type: 'object', properties: {} } },
	execute: async () => `${name} output`,
	evidence: (_a, output) => ({ ref: name, excerpt: output }),
	...extra
});

async function run(tools: LoopTool[]): Promise<TurnSummary> {
	let summary: TurnSummary | null = null;
	await runAgentLoop({
		job: createJob({ chatId: 'ev1', userId: 'u1', task: 'chat', persist: false }),
		task: 'chat',
		userId: 'u1',
		chatId: 'ev1',
		persist: false,
		primary: callingChoice(),
		backup: null,
		tools,
		maxIterations: 4,
		buildMessages: () => [{ role: 'system', content: 'sys' }],
		onDone: (_t, _u, _c, s) => {
			summary = s;
		}
	});
	return summary!;
}

describe('the evidence a turn hands on', () => {
	it('takes what a tool read, in call order', async () => {
		const summary = await run([tool('first', {}), tool('second', {})]);
		expect(summary.evidence).toEqual([
			{ tool: 'first', ref: 'first', excerpt: 'first output' },
			{ tool: 'second', ref: 'second', excerpt: 'second output' }
		]);
	});

	it('never takes anything from a tool whose arguments describe a person', async () => {
		const summary = await run([tool('profile_lookup', { privateArgs: true })]);
		expect(summary.evidence).toEqual([]);
	});

	it('skips a call that failed', async () => {
		const summary = await run([
			tool('broken', {
				execute: async () => {
					throw new Error('no');
				}
			})
		]);
		expect(summary.evidence).toEqual([]);
	});

	it('lets a broken hook cost only the evidence', async () => {
		const summary = await run([
			tool('fine', {
				evidence: () => {
					throw new Error('hook bug');
				}
			})
		]);
		expect(summary.evidence).toEqual([]);
		expect(summary.toolCalls.map((c) => c.status)).toEqual(['ok']);
	});

	it('keeps what an attempt read when the model fails after it and the retry replays the call', async () => {
		let modelCalls = 0;
		const flaky = callingChoice();
		const inner = flaky.adapter.stream.bind(flaky.adapter);
		flaky.adapter.stream = async function* (req: ChatRequest) {
			modelCalls++;
			// The second model call of the first attempt dies, after the tool ran.
			if (modelCalls === 2) throw new TypeError('connection reset');
			yield* inner(req);
		};
		let reads = 0;
		const memoised = tool('fetch_url', {
			execute: async (_a, report) => {
				reads++;
				report?.({ cached: reads > 1 });
				return 'page text';
			},
			// As the real tools do: a replay from the per-turn memo hands on nothing.
			evidence: (_a, output, meta) => (meta.cached ? null : { ref: 'https://e.test', excerpt: output })
		});
		let summary: TurnSummary | null = null;
		await runAgentLoop({
			job: createJob({ chatId: 'ev2', userId: 'u1', task: 'chat', persist: false }),
			task: 'chat',
			userId: 'u1',
			chatId: 'ev2',
			persist: false,
			primary: flaky,
			backup: null,
			tools: [memoised],
			maxIterations: 4,
			buildMessages: () => [{ role: 'system', content: 'sys' }],
			onDone: (_t, _u, _c, s) => {
				summary = s;
			}
		});
		expect(reads).toBe(2);
		expect(summary!.evidence).toEqual([{ tool: 'fetch_url', ref: 'https://e.test', excerpt: 'page text' }]);
	});
});
