import { beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '$lib/server/db';
import type { ModelChoice } from '$lib/server/providers/registry';
import type { ProviderMessage, StreamEvent } from '$lib/server/providers/types';
import { createJob } from './jobs';
import { parseToolArgs, runAgentLoop, type LoopTool } from './loop';

/**
 * What a tool is handed when the model's arguments are not a clean JSON object.
 *
 * Unreadable arguments used to become `{}` and the tool ran anyway, so the
 * failure surfaced as the tool's own complaint about a missing field. A
 * set_chat_title call reached the feed as "title is required" with an empty
 * summary, and what the model had actually sent was gone.
 */

beforeAll(() => {
	runMigrations();
});

describe('parseToolArgs', () => {
	it('reads an object, and treats empty as no arguments', () => {
		expect(parseToolArgs('{"title":"x"}')).toEqual({ args: { title: 'x' } });
		expect(parseToolArgs('')).toEqual({ args: {} });
		expect(parseToolArgs('  ')).toEqual({ args: {} });
	});

	it('unwraps arguments encoded twice', () => {
		expect(parseToolArgs(JSON.stringify('{"title":"x"}'))).toEqual({ args: { title: 'x' } });
	});

	it('names what is wrong with anything else', () => {
		expect(parseToolArgs('{"title":"x"')).toEqual({ args: {}, problem: 'not valid JSON' });
		expect(parseToolArgs('[1]')).toEqual({ args: {}, problem: 'not a JSON object' });
		expect(parseToolArgs('null')).toEqual({ args: {}, problem: 'not a JSON object' });
		expect(parseToolArgs('"hello"')).toEqual({ args: {}, problem: 'not a JSON object' });
	});
});

/** One tool call with these raw arguments, then an answer. Returns what the tool and model saw. */
async function runWith(rawArgs: string) {
	const received: Record<string, unknown>[] = [];
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
				seen.push(structuredClone(req.messages));
				if (call++ === 0) {
					yield { type: 'tool_calls', calls: [{ id: 'c1', name: 'probe', arguments: rawArgs }] };
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
	const probe: LoopTool = {
		def: { name: 'probe', description: 'records its arguments', parameters: { type: 'object' } },
		execute: async (args) => {
			received.push(args);
			return 'ok';
		}
	};
	const job = createJob({ chatId: 'args1', userId: 'u1', task: 'chat', persist: false });
	await runAgentLoop({
		job,
		task: 'chat',
		userId: 'u1',
		chatId: 'args1',
		persist: false,
		primary: choice,
		backup: null,
		tools: [probe],
		maxIterations: 4,
		buildMessages: () => [{ role: 'system', content: 'You are a test agent.' }],
		onDone: () => {}
	});
	const toolReply = seen[1]?.find((m) => m.role === 'tool');
	return { received, toolReply: String(toolReply?.content ?? '') };
}

describe('tool calls with unreadable arguments', () => {
	it('are not run, and tell the model what it sent', async () => {
		const { received, toolReply } = await runWith('{"title": "Postgres');
		expect(received).toHaveLength(0);
		expect(toolReply).toContain('could not be read (not valid JSON)');
		expect(toolReply).toContain('Postgres');
	});

	it('reach the tool as an object when they were only encoded twice', async () => {
		const { received } = await runWith(JSON.stringify('{"title":"Postgres pooling"}'));
		expect(received).toEqual([{ title: 'Postgres pooling' }]);
	});
});
