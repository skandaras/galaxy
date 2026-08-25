import { beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '$lib/server/db';
import type { ModelChoice } from '$lib/server/providers/registry';
import type { ChatRequest, StreamEvent, ToolCall } from '$lib/server/providers/types';
import { cancelJob, createJob, type JobChunk } from './jobs';
import { batchToolCalls, runAgentLoop, type LoopTool, type TurnSummary } from './loop';

beforeAll(() => {
	runMigrations();
});

const call = (id: string, name: string, args: Record<string, unknown> = {}): ToolCall => ({
	id,
	name,
	arguments: JSON.stringify(args)
});

describe('batchToolCalls', () => {
	const safeNames = new Set(['read_file', 'grep_files']);
	const safe = (name: string) => safeNames.has(name);

	it('runs a stretch of parallel-safe calls together', () => {
		const calls = [call('a', 'read_file'), call('b', 'read_file'), call('c', 'grep_files')];
		expect(batchToolCalls(calls, safe).map((b) => b.map((c) => c.id))).toEqual([['a', 'b', 'c']]);
	});

	it('gives anything unmarked a batch to itself', () => {
		const calls = [call('a', 'write_file'), call('b', 'bash')];
		expect(batchToolCalls(calls, safe).map((b) => b.map((c) => c.id))).toEqual([['a'], ['b']]);
	});

	it('treats a write as a barrier between reads', () => {
		// The ordering guarantee that makes any of this safe: read, write, read
		// must not become read+read then write.
		const calls = [
			call('r1', 'read_file'),
			call('w', 'write_file'),
			call('r2', 'read_file'),
			call('r3', 'read_file')
		];
		expect(batchToolCalls(calls, safe).map((b) => b.map((c) => c.id))).toEqual([
			['r1'],
			['w'],
			['r2', 'r3']
		]);
	});

	it('treats an unknown tool as unsafe', () => {
		// parallelSafe is undefined for a tool the loop cannot find, and undefined
		// must never read as "go ahead".
		const calls = [call('a', 'read_file'), call('b', 'nonesuch'), call('c', 'read_file')];
		expect(batchToolCalls(calls, (n) => (safeNames.has(n) ? true : undefined))).toHaveLength(3);
	});

	it('has nothing to do with an empty round', () => {
		expect(batchToolCalls([], safe)).toEqual([]);
	});
});

/** A model that asks for one scripted batch of calls, then answers. */
function batchingChoice(calls: ToolCall[]): ModelChoice {
	let done = false;
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
				if (!done) {
					done = true;
					yield { type: 'tool_calls', calls };
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

/**
 * Tools that report how many of them were running at once, which is the only
 * way to tell a batch that ran concurrently from one that merely finished.
 */
function watchedTools() {
	let inFlight = 0;
	let peak = 0;
	const order: string[] = [];
	const make = (name: string, parallelSafe: boolean): LoopTool => ({
		def: { name, description: name, parameters: {} },
		parallelSafe,
		describe: (a) => String(a.path ?? name),
		execute: async (a) => {
			inFlight++;
			peak = Math.max(peak, inFlight);
			order.push(`start:${String(a.path ?? name)}`);
			await new Promise((r) => setTimeout(r, 15));
			order.push(`end:${String(a.path ?? name)}`);
			inFlight--;
			return `contents of ${String(a.path ?? name)}`;
		}
	});
	return {
		tools: [make('read_file', true), make('write_file', false)],
		peak: () => peak,
		order: () => order
	};
}

async function run(opts: {
	calls: ToolCall[];
	tools: LoopTool[];
	cancelAfterMs?: number;
}): Promise<{ summary: TurnSummary | null; chunks: JobChunk[] }> {
	const job = createJob({ chatId: 'par1', userId: 'u1', task: 'coding', persist: false });
	const chunks: JobChunk[] = [];
	job.subscribers.add((c) => chunks.push(c));
	let summary: TurnSummary | null = null;
	if (opts.cancelAfterMs !== undefined) setTimeout(() => cancelJob(job), opts.cancelAfterMs);
	await runAgentLoop({
		job,
		task: 'coding',
		userId: 'u1',
		chatId: 'par1',
		persist: false,
		primary: batchingChoice(opts.calls),
		backup: null,
		tools: opts.tools,
		maxIterations: 6,
		buildMessages: () => [{ role: 'system', content: 'You are a test agent.' }],
		onDone: (_t, _u, _c, s) => {
			summary = s;
		}
	});
	return { summary, chunks };
}

describe('executing a round of tool calls', () => {
	it('runs parallel-safe calls at the same time', async () => {
		const watched = watchedTools();
		await run({
			calls: [
				call('a', 'read_file', { path: 'a.ts' }),
				call('b', 'read_file', { path: 'b.ts' }),
				call('c', 'read_file', { path: 'c.ts' })
			],
			tools: watched.tools
		});
		// The whole point: three reads the model asked for in one turn used to
		// cost three round-trips in series.
		expect(watched.peak()).toBe(3);
	});

	it('keeps the trace in call order however the batch finishes', async () => {
		const watched = watchedTools();
		const { summary } = await run({
			calls: [
				call('a', 'read_file', { path: 'a.ts' }),
				call('b', 'read_file', { path: 'b.ts' }),
				call('c', 'read_file', { path: 'c.ts' })
			],
			tools: watched.tools
		});
		expect(summary?.toolCalls.map((c) => c.summary)).toEqual(['a.ts', 'b.ts', 'c.ts']);
		expect(summary?.toolCalls.every((c) => c.status === 'ok')).toBe(true);
	});

	it('holds a write back until the reads before it are done', async () => {
		const watched = watchedTools();
		await run({
			calls: [
				call('a', 'read_file', { path: 'a.ts' }),
				call('b', 'read_file', { path: 'b.ts' }),
				call('w', 'write_file', { path: 'out.ts' })
			],
			tools: watched.tools
		});
		const order = watched.order();
		// Nothing about the write may overlap the reads: it is a barrier.
		expect(order.indexOf('start:out.ts')).toBeGreaterThan(order.indexOf('end:a.ts'));
		expect(order.indexOf('start:out.ts')).toBeGreaterThan(order.indexOf('end:b.ts'));
		expect(watched.peak()).toBe(2);
	});

	it('runs writes one at a time, in the order asked for', async () => {
		const watched = watchedTools();
		await run({
			calls: [
				call('w1', 'write_file', { path: 'one.ts' }),
				call('w2', 'write_file', { path: 'two.ts' })
			],
			tools: watched.tools
		});
		expect(watched.peak()).toBe(1);
		expect(watched.order()).toEqual([
			'start:one.ts',
			'end:one.ts',
			'start:two.ts',
			'end:two.ts'
		]);
	});

	it('stops starting batches once the run is cancelled', async () => {
		const watched = watchedTools();
		const { summary } = await run({
			calls: [
				call('w1', 'write_file', { path: 'one.ts' }),
				call('w2', 'write_file', { path: 'two.ts' }),
				call('w3', 'write_file', { path: 'three.ts' })
			],
			tools: watched.tools,
			// Part-way through the first write, which is a barrier of its own.
			cancelAfterMs: 5
		});
		expect(summary?.stopReason).toBe('cancelled');
		expect(watched.order()).not.toContain('start:three.ts');
	});
});
