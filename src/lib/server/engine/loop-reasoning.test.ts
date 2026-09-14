import { beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '$lib/server/db';
import type { ModelChoice } from '$lib/server/providers/registry';
import type { ChatRequest, ReasoningEffort, StreamEvent } from '$lib/server/providers/types';
import { createJob } from './jobs';
import { runAgentLoop } from './loop';

/**
 * What the loop tells the provider about how hard to think.
 *
 * This existed nowhere for the whole life of `reasoningFor`: every background
 * job asked for `'low'` and the agent loop — the only path somebody sits and
 * waits on — asked for nothing, so a reasoning model deliberated at its own
 * default and spent four fifths of a chat turn's output thinking before it said
 * anything. Nothing failed, which is why it went unnoticed; the assertions here
 * are on a request field, because that is where the omission lived.
 */

beforeAll(() => {
	runMigrations();
});

/** A model that answers at once, keeping every request it was handed. */
function recordingChoice(model: Record<string, unknown>) {
	const seen: ChatRequest[] = [];
	const choice = {
		model: {
			modelKey: 'mock',
			displayName: 'Mock',
			supportsTools: true,
			supportsVision: false,
			supportsReasoning: true,
			reasoningMode: 'auto',
			promptCostPerMTok: null,
			completionCostPerMTok: null,
			...model
		},
		provider: {},
		adapter: {
			async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
				seen.push(req);
				yield { type: 'text', delta: 'Answered.' };
				yield { type: 'done', finishReason: 'stop' };
			},
			complete: async () => ({ text: '', usage: null }),
			listModels: async () => []
		}
	} as unknown as ModelChoice;
	return { choice, seen };
}

async function run(opts: {
	reasoning?: ReasoningEffort;
	model?: Record<string, unknown>;
}): Promise<ChatRequest[]> {
	const { choice, seen } = recordingChoice(opts.model ?? {});
	const job = createJob({ chatId: 'rsn1', userId: 'u1', task: 'chat', persist: false });
	await runAgentLoop({
		job,
		task: 'chat',
		userId: 'u1',
		chatId: 'rsn1',
		persist: false,
		primary: choice,
		backup: null,
		tools: [],
		maxIterations: 4,
		reasoning: opts.reasoning,
		buildMessages: () => [{ role: 'system', content: 'You are a test agent.' }],
		onDone: () => {}
	});
	return seen;
}

describe('the reasoning effort the agent loop asks for', () => {
	it('sends what the task asked for', async () => {
		expect((await run({ reasoning: 'low' }))[0].reasoning).toBe('low');
	});

	it('sends nothing when the task asks for nothing', async () => {
		// Coding still wants this: a long repository turn is not waiting on a
		// first token the way a chat is, so it keeps the model's own default.
		expect((await run({}))[0].reasoning).toBeUndefined();
	});

	it('drops the field for a model that never advertised it', async () => {
		// The case worth having a test for. An endpoint that has not heard of the
		// field is entitled to reject the whole request over it, so asking for
		// less thinking must never cost the call itself.
		const seen = await run({ reasoning: 'low', model: { supportsReasoning: false } });
		expect(seen[0].reasoning).toBeUndefined();
	});

	it('lets an admin override what the task asked for, in either direction', async () => {
		const up = await run({ reasoning: 'low', model: { reasoningMode: 'high' } });
		expect(up[0].reasoning).toBe('high');
		const down = await run({ reasoning: undefined, model: { reasoningMode: 'low' } });
		expect(down[0].reasoning).toBe('low');
	});
});
