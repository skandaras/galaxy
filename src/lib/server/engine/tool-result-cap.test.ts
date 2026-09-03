import { beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '$lib/server/db';
import type { ModelChoice } from '$lib/server/providers/registry';
import type { ChatRequest, ProviderMessage, StreamEvent } from '$lib/server/providers/types';
import { createJob } from './jobs';
import { toolResultMaxChars } from './limits';
import { runAgentLoop, type LoopTool } from './loop';

/**
 * The ceiling on what one tool call may put into the message array.
 *
 * Tools cap themselves, but each with a different limit and several with none
 * at all — an MCP server, board_read, run_history and skill_load could each
 * hand back a document of any size. The only thing catching that was
 * elideOldToolOutput, which drops whole results after the fact rather than
 * stopping an oversized one going in.
 */

beforeAll(() => runMigrations());

/**
 * A model that calls the tool once, then answers — capturing the message array
 * it is handed on the second round, which is where the tool result shows up.
 */
function recordingChoice(seen: ProviderMessage[][]): ModelChoice {
	let called = false;
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
			async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
				seen.push(req.messages);
				if (!called) {
					called = true;
					yield {
						type: 'tool_calls',
						calls: [{ id: 't1', name: 'big_tool', arguments: '{}' }]
					};
				} else {
					yield { type: 'text', delta: 'Done.' };
				}
				yield { type: 'done', finishReason: 'stop' };
			},
			complete: async () => ({ text: '', usage: null }),
			listModels: async () => []
		}
	} as unknown as ModelChoice;
}

async function runWithResult(result: string): Promise<ProviderMessage[][]> {
	const seen: ProviderMessage[][] = [];
	const job = createJob({ chatId: 'cap1', userId: 'u1', task: 'chat', persist: false });
	const tool: LoopTool = {
		// Deliberately declares no cap of its own — the point is the backstop.
		def: { name: 'big_tool', description: 'returns whatever it likes', parameters: {} },
		execute: async () => result
	};
	await runAgentLoop({
		job,
		task: 'chat',
		userId: 'u1',
		chatId: 'cap1',
		persist: false,
		primary: recordingChoice(seen),
		backup: null,
		tools: [tool],
		maxIterations: 4,
		buildMessages: () => [{ role: 'system', content: 'You are a test agent.' }],
		onDone: () => {}
	});
	return seen;
}

const toolMessage = (seen: ProviderMessage[][]) => {
	const last = seen.at(-1)!;
	return last.find((m) => m.role === 'tool')!;
};

describe('a tool that caps nothing itself', () => {
	it('cannot put more than the budget into the message array', async () => {
		const cap = toolResultMaxChars();
		const seen = await runWithResult('x'.repeat(cap * 3));
		const content = toolMessage(seen).content as string;

		expect(content.length).toBeLessThan(cap * 3);
		expect(content.startsWith('x'.repeat(cap))).toBe(true);
	});

	it('says it was truncated, and how big the real answer was', async () => {
		// Silently handing back a prefix is worse than handing back nothing: the
		// model reads a half-file as the whole file and reasons from it.
		const seen = await runWithResult('y'.repeat(toolResultMaxChars() + 500));
		const content = toolMessage(seen).content as string;
		expect(content).toContain('big_tool returned');
		expect(content).toContain('truncated at');
	});

	it('leaves a result that already fits completely alone', async () => {
		const seen = await runWithResult('small answer');
		expect(toolMessage(seen).content).toBe('small answer');
	});
});
