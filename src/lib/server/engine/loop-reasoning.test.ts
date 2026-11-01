import { beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '$lib/server/db';
import type { ModelChoice } from '$lib/server/providers/registry';
import type {
	ChatRequest,
	ProviderMessage,
	ReasoningEffort,
	StreamEvent
} from '$lib/server/providers/types';
import { createJob } from './jobs';
import { elideOldToolOutput, forModel, runAgentLoop } from './loop';

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

/**
 * The reasoning a model returns with its tool calls, carried to the next round
 * trip of the same chain and nowhere else.
 */
describe('reasoning details across a tool chain', () => {
	const DETAILS = [
		{ type: 'reasoning.text', text: 'Look it up first', signature: 'sig-SECRET-1' },
		{ type: 'reasoning.encrypted', data: 'ENC-SECRET-2' }
	];

	/** Calls a tool once, with reasoning attached, then answers. */
	function chainingChoice(id: string, opts: { failFirst?: boolean } = {}) {
		const seen: ChatRequest[] = [];
		let calls = 0;
		const choice = {
			model: {
				id,
				modelKey: `mock-${id}`,
				displayName: id,
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
					// A copy, because the loop keeps pushing onto the same array.
					seen.push({ ...req, messages: req.messages.map((m) => ({ ...m })) });
					calls++;
					if (opts.failFirst) throw new TypeError('network down');
					if (req.messages.some((m) => m.role === 'tool')) {
						yield { type: 'text', delta: 'Done.' };
						yield { type: 'done', finishReason: 'stop' };
						return;
					}
					yield { type: 'reasoning', delta: 'Look it up first' };
					yield { type: 'reasoning_details', details: DETAILS };
					yield { type: 'tool_calls', calls: [{ id: `c${calls}`, name: 'lookup', arguments: '{}' }] };
					yield { type: 'done', finishReason: 'tool_calls' };
				},
				complete: async () => ({ text: '', usage: null }),
				listModels: async () => []
			}
		} as unknown as ModelChoice;
		return { choice, seen };
	}

	const lookup = {
		def: { name: 'lookup', description: 'Look something up', parameters: { type: 'object', properties: {} } },
		execute: async () => 'found it'
	};

	it('goes back on the tool-call message, tagged with the model that wrote it, and leaks nowhere', async () => {
		const { choice, seen } = chainingChoice('row-primary');
		const job = createJob({ chatId: 'rd1', userId: 'u1', task: 'chat', persist: false });
		let summaryJson = '';
		await runAgentLoop({
			job,
			task: 'chat',
			userId: 'u1',
			chatId: 'rd1',
			persist: false,
			primary: choice,
			backup: null,
			tools: [lookup],
			maxIterations: 4,
			buildMessages: () => [
				{ role: 'system', content: 'sys' },
				{ role: 'user', content: 'go' }
			],
			onDone: (_text, _usage, _choice, summary) => {
				summaryJson = JSON.stringify({ trace: summary.trace, toolCalls: summary.toolCalls });
			}
		});
		const assistant = seen[1].messages.find((m) => m.role === 'assistant' && m.tool_calls)!;
		expect(assistant.reasoningDetails).toEqual({ modelId: 'row-primary', items: DETAILS });
		// What the browser and the Observatory see: the readable note at most,
		// never the signature or the encrypted blob.
		const outward = JSON.stringify(job.chunks) + summaryJson;
		expect(outward).not.toContain('sig-SECRET-1');
		expect(outward).not.toContain('ENC-SECRET-2');
	});

	it('is stripped from a carried transcript before it reaches a different model', async () => {
		const primary = chainingChoice('row-primary', { failFirst: true });
		const backup = chainingChoice('row-backup');
		// A continued coding leg: the transcript arrives already holding a chain
		// the primary wrote.
		const carried = [
			{ role: 'system' as const, content: 'sys' },
			{ role: 'user' as const, content: 'go' },
			{
				role: 'assistant' as const,
				content: '',
				tool_calls: [{ id: 'old', name: 'lookup', arguments: '{}' }],
				reasoningDetails: { modelId: 'row-primary', items: DETAILS }
			},
			{ role: 'tool' as const, content: 'found it', tool_call_id: 'old' }
		];
		const job = createJob({ chatId: 'rd2', userId: 'u1', task: 'coding', persist: false });
		await runAgentLoop({
			job,
			task: 'coding',
			userId: 'u1',
			chatId: 'rd2',
			persist: false,
			primary: primary.choice,
			backup: backup.choice,
			tools: [lookup],
			maxIterations: 4,
			buildMessages: () => carried,
			onDone: () => {}
		});
		// The positive control: the primary was offered its own blocks.
		expect(primary.seen[0].messages[2].reasoningDetails?.modelId).toBe('row-primary');
		// The backup was not, and the shared transcript was not edited to get there.
		expect(backup.seen[0].messages[2].reasoningDetails).toBeUndefined();
		expect(carried[2].reasoningDetails).toBeDefined();
	});

	it('survives eliding old tool output, with the call it signed left as written', () => {
		const big = JSON.stringify({ path: 'a.ts', content: 'x'.repeat(5_000) });
		const messages = [
			{ role: 'system' as const, content: 'sys' },
			{
				role: 'assistant' as const,
				content: '',
				tool_calls: [{ id: 'w', name: 'write_file', arguments: big }],
				reasoningDetails: { modelId: 'row-primary', items: DETAILS }
			},
			{ role: 'tool' as const, content: 'y'.repeat(5_000), tool_call_id: 'w' },
			{ role: 'assistant' as const, content: '', tool_calls: [{ id: 'r', name: 'read_file', arguments: '{}' }] },
			{ role: 'tool' as const, content: 'ok', tool_call_id: 'r' }
		];
		elideOldToolOutput(messages, 6_000);
		expect(messages[1].reasoningDetails?.items).toEqual(DETAILS);
		expect(messages[1].tool_calls![0].arguments).toBe(big);
		// The result beside it can still go.
		expect(messages[2].content).not.toContain('yyyy');
	});

	it('gives up an old step\'s reasoning rather than the results the model has not read yet', () => {
		const signed = (id: string): ProviderMessage[] => [
			{
				role: 'assistant',
				content: '',
				tool_calls: [{ id, name: 'write_file', arguments: JSON.stringify({ path: `${id}.ts`, content: 'x'.repeat(4_000) }) }],
				reasoningDetails: { modelId: 'row-primary', items: [{ type: 'reasoning.encrypted', data: 'e'.repeat(4_000) }] }
			},
			{ role: 'tool', content: `${id} written`, tool_call_id: id }
		];
		const messages: ProviderMessage[] = [{ role: 'system', content: 'sys' }, ...signed('a'), ...signed('b')];
		elideOldToolOutput(messages, 9_000);
		// The newest exchange is whole: its result is unread and its block intact.
		expect(messages[4].content).toBe('b written');
		expect(messages[3].reasoningDetails).toBeDefined();
		// The oldest paid for it.
		expect(messages[1].reasoningDetails).toBeUndefined();
		expect(messages[1].tool_calls![0].arguments).toContain('characters, dropped from context');
	});

	it('leaves messages from the same model, and messages with none, as the same objects', () => {
		const own = { role: 'assistant' as const, content: '', reasoningDetails: { modelId: 'a', items: DETAILS } };
		const plain = { role: 'user' as const, content: 'hi' };
		const out = forModel([own, plain], 'a');
		expect(out[0]).toBe(own);
		expect(out[1]).toBe(plain);
		expect(forModel([own], 'b')[0]).not.toHaveProperty('reasoningDetails');
	});
});
