import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, runMigrations } from '$lib/server/db';
import { usageLog } from '$lib/server/db/schema';
import { setSetting } from '$lib/server/settings';
import type { ModelChoice } from '$lib/server/providers/registry';
import type { ChatRequest, StreamEvent, ToolCall } from '$lib/server/providers/types';
import { getBudgetStatus } from './budget';
import { cancelJob, createJob } from './jobs';
import { runAgentLoop, type LoopTool } from './loop';

/**
 * One usage row per provider call, not one per attempt.
 *
 * The loop used to accumulate across every iteration and write once at the end,
 * which made the mid-run budget check useless: `budgetBlocked` reads the
 * database, and the database could not see a single token of the run doing the
 * asking. These pin the three things that fixes — the row count, the cap
 * actually biting mid-run, and the paths that must still write on the way out.
 */

beforeAll(() => runMigrations());

beforeEach(() => {
	db.delete(usageLog).run();
	setSetting('budget', { enabled: false, limitUsd: 0, period: 'day' });
});

/** Priced, so rows carry a real cost and the cap has something to sum. */
function pricedChoice(opts: { toolRounds: number; failAt?: number }): ModelChoice {
	let round = 0;
	return {
		model: {
			modelKey: 'mock',
			displayName: 'Mock',
			supportsTools: true,
			supportsVision: false,
			// $1 per million each way: 1,000 prompt + 1,000 completion = $0.002 a call.
			promptCostPerMTok: 1,
			completionCostPerMTok: 1
		},
		provider: {},
		adapter: {
			async *stream(_req: ChatRequest): AsyncGenerator<StreamEvent> {
				const call: ToolCall = {
					id: `c${round}`,
					name: 'read_file',
					arguments: JSON.stringify({ path: `file${round}.ts` })
				};
				if (opts.failAt !== undefined && round === opts.failAt) {
					yield { type: 'usage', usage: { promptTokens: 1_000, completionTokens: 1_000 } };
					throw new Error('provider fell over');
				}
				yield { type: 'usage', usage: { promptTokens: 1_000, completionTokens: 1_000 } };
				if (round < opts.toolRounds) {
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
}) {
	const job = createJob({ chatId: 'c1', userId: 'u1', task: 'coding', persist: false });
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
		buildMessages: () => [{ role: 'system', content: 'You are a test agent.' }],
		onDone: () => ''
	});
	return db.select().from(usageLog).all();
}

describe('one row per provider call', () => {
	it('writes a row for every call in a multi-step run', async () => {
		const rows = await run({ choice: pricedChoice({ toolRounds: 3 }), maxIterations: 20 });
		// Three tool rounds plus the closing answer.
		expect(rows).toHaveLength(4);
		for (const row of rows) {
			expect(row.promptTokens).toBe(1_000);
			expect(row.costUsd).toBeCloseTo(0.002, 6);
		}
	});

	it('makes the run its own spend visible to the cap while it is still running', async () => {
		// Two calls' worth. The third must not happen.
		setSetting('budget', { enabled: true, limitUsd: 0.005, period: 'day' });
		const seen: number[] = [];
		const rows = await run({
			choice: pricedChoice({ toolRounds: 20 }),
			maxIterations: 20,
			budgetBlocked: () => {
				// The real predicate, reading the real table — the point of the change
				// is that this can now see the run that is asking.
				const status = getBudgetStatus();
				seen.push(status.spentUsd);
				return status.blocked;
			}
		});
		// It stopped rather than running to the twenty-step ceiling.
		expect(rows.length).toBeLessThan(20);
		// And it stopped because the sum it read was real, not zero.
		expect(Math.max(...seen)).toBeGreaterThan(0);
	});

	it('keeps the tokens of a call that failed', async () => {
		await expect(
			run({ choice: pricedChoice({ toolRounds: 5, failAt: 2 }), maxIterations: 20 })
		).resolves.toBeDefined();
		const rows = db.select().from(usageLog).all();
		// Two calls succeeded, the third burned tokens and died.
		expect(rows).toHaveLength(3);
		expect(rows.filter((r) => r.status === 'error')).toHaveLength(1);
		expect(rows.every((r) => r.promptTokens === 1_000)).toBe(true);
	});

	it('keeps the tokens of a run the user stopped', async () => {
		// Stopping does not refund what the provider has already been paid for.
		const rows = await run({
			choice: pricedChoice({ toolRounds: 50 }),
			maxIterations: 50,
			cancelAfterMs: 5
		});
		expect(rows.length).toBeGreaterThan(0);
		expect(rows.every((r) => r.promptTokens === 1_000)).toBe(true);
	});
});

describe('reasoning tokens', () => {
	it('survives the loop, which used to drop them', async () => {
		const choice = {
			model: {
				modelKey: 'mock',
				displayName: 'Mock',
				supportsTools: false,
				supportsVision: false,
				promptCostPerMTok: null,
				completionCostPerMTok: null
			},
			provider: {},
			adapter: {
				async *stream(): AsyncGenerator<StreamEvent> {
					yield {
						type: 'usage',
						usage: { promptTokens: 10, completionTokens: 900, reasoningTokens: 850 }
					};
					yield { type: 'text', delta: 'Thought about it.' };
					yield { type: 'done', finishReason: 'stop' };
				},
				complete: async () => ({ text: '', usage: null }),
				listModels: async () => []
			}
		} as unknown as ModelChoice;
		const rows = await run({ choice, maxIterations: 4 });
		expect(rows).toHaveLength(1);
		// 850 of 900 output tokens were deliberation, which is the whole point of
		// the column — it read zero for every row the loop wrote.
		expect(rows[0].reasoningTokens).toBe(850);
	});
});
