import { beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '$lib/server/db';
import type { ModelChoice } from '$lib/server/providers/registry';
import type { ProviderMessage, StreamEvent } from '$lib/server/providers/types';
import { createJob } from './jobs';
import { runAgentLoop, type LoopTool } from './loop';

/**
 * The loop carrying an adapter's own record of a turn into the next call.
 *
 * The Responses adapter needs a reasoning model's encrypted reasoning sent
 * back ahead of the function call it produced. The loop is the only thing
 * holding the transcript between those two calls, so if it drops the items the
 * adapter has nothing to replay, and the model starts every tool step cold.
 */

beforeAll(() => {
	runMigrations();
});

const reasoning = { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque' };

describe('provider items in the agent loop', () => {
	it('attaches them to the assistant turn the next call is sent', async () => {
		const seen: ProviderMessage[][] = [];
		let call = 0;
		const choice = {
			model: {
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
				async *stream(req: { messages: ProviderMessage[] }): AsyncGenerator<StreamEvent> {
					// A copy: the loop keeps appending to the array it passed.
					seen.push(structuredClone(req.messages));
					if (call++ === 0) {
						yield { type: 'provider_items', items: [reasoning] };
						yield { type: 'tool_calls', calls: [{ id: 'c1', name: 'noop', arguments: '{}' }] };
						yield { type: 'done', finishReason: 'tool_calls' };
						return;
					}
					yield { type: 'text', delta: 'Done.' };
					yield { type: 'done', finishReason: 'stop' };
				},
				complete: async () => ({ text: '', usage: null }),
				listModels: async () => []
			}
		} as unknown as ModelChoice;
		const noop: LoopTool = {
			def: { name: 'noop', description: 'does nothing', parameters: { type: 'object' } },
			execute: async () => 'ok'
		};
		const job = createJob({ chatId: 'pi1', userId: 'u1', task: 'chat', persist: false });
		await runAgentLoop({
			job,
			task: 'chat',
			userId: 'u1',
			chatId: 'pi1',
			persist: false,
			primary: choice,
			backup: null,
			tools: [noop],
			maxIterations: 4,
			buildMessages: () => [{ role: 'system', content: 'You are a test agent.' }],
			onDone: () => {}
		});

		expect(seen).toHaveLength(2);
		const assistant = seen[1].find((m) => m.role === 'assistant');
		expect(assistant?.providerItems).toEqual([reasoning]);
		expect(assistant?.tool_calls?.[0].id).toBe('c1');
	});
});
