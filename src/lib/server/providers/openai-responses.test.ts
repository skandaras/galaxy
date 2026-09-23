import { afterEach, describe, it, expect, vi } from 'vitest';
import {
	createOpenAiResponsesAdapter,
	knownModel,
	parseResponsesStream,
	readResponse,
	readResponsesUsage,
	responsesBody,
	toInputItems
} from './openai-responses';
import { ProviderHttpError, type ProviderMessage, type StreamEvent } from './types';

function streamOf(...lines: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			for (const line of lines) controller.enqueue(encoder.encode(line));
			controller.close();
		}
	});
}

const event = (obj: { type: string } & Record<string, unknown>) =>
	`event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`;

async function collectAll(stream: ReadableStream<Uint8Array>): Promise<StreamEvent[]> {
	const events: StreamEvent[] = [];
	for await (const ev of parseResponsesStream(stream, 'gpt-5.6-terra')) events.push(ev);
	return events;
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<StreamEvent[]> {
	return (await collectAll(stream)).filter((e) => e.type !== 'progress');
}

const reasoningItem = {
	type: 'reasoning',
	id: 'rs_1',
	summary: [],
	encrypted_content: 'opaque'
};
const callItem = {
	type: 'function_call',
	id: 'fc_1',
	call_id: 'call_1',
	name: 'read_file',
	arguments: '{"path":"a.ts"}',
	status: 'completed'
};

describe('knownModel', () => {
	it('matches an alias and its dated snapshots, and nothing else', () => {
		expect(knownModel('gpt-5.6-sol')?.displayName).toBe('GPT-5.6 Sol');
		expect(knownModel('gpt-5.6-sol-2026-08-01')?.displayName).toBe('GPT-5.6 Sol');
		expect(knownModel('gpt-5.6-solx')).toBeUndefined();
		expect(knownModel('gpt-5.6')).toBeUndefined();
	});
});

describe('toInputItems', () => {
	it('maps each role onto its Responses item, keeping order', () => {
		const messages: ProviderMessage[] = [
			{ role: 'system', content: 'be brief' },
			{ role: 'user', content: 'read a.ts' },
			{
				role: 'assistant',
				content: 'Reading it.',
				tool_calls: [{ id: 'call_1', name: 'read_file', arguments: '{"path":"a.ts"}' }]
			},
			{ role: 'tool', content: 'file body', tool_call_id: 'call_1' },
			{ role: 'system', content: '[state]' }
		];
		expect(toInputItems(messages)).toEqual([
			{ type: 'message', role: 'developer', content: 'be brief' },
			{ type: 'message', role: 'user', content: 'read a.ts' },
			{ type: 'message', role: 'assistant', content: 'Reading it.' },
			{ type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a.ts"}' },
			{ type: 'function_call_output', call_id: 'call_1', output: 'file body' },
			{ type: 'message', role: 'developer', content: '[state]' }
		]);
	});

	it('turns image parts into input_image', () => {
		const items = toInputItems([
			{
				role: 'user',
				content: [
					{ type: 'text', text: 'what is this' },
					{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
				]
			}
		]);
		expect(items).toEqual([
			{
				type: 'message',
				role: 'user',
				content: [
					{ type: 'input_text', text: 'what is this' },
					{ type: 'input_image', image_url: 'data:image/png;base64,AAAA' }
				]
			}
		]);
	});

	it('replays provider items in place of the reconstructed turn', () => {
		const items = toInputItems([
			{
				role: 'assistant',
				content: '',
				tool_calls: [{ id: 'call_1', name: 'read_file', arguments: '{"path":"a.ts"}' }],
				providerItems: [reasoningItem, callItem]
			},
			{ role: 'tool', content: 'x', tool_call_id: 'call_1' }
		]);
		expect(items).toEqual([
			{ type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'opaque' },
			// The stored-item id is gone: with store off there is nothing for it to name.
			{ type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a.ts"}' },
			{ type: 'function_call_output', call_id: 'call_1', output: 'x' }
		]);
	});

	it('drops a reasoning item that came back without its encrypted content', () => {
		const items = toInputItems([
			{
				role: 'assistant',
				content: '',
				tool_calls: [{ id: 'call_1', name: 'read_file', arguments: '{}' }],
				providerItems: [{ type: 'reasoning', id: 'rs_1', summary: [] }, callItem]
			}
		]);
		expect(items).toEqual([
			{ type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a.ts"}' }
		]);
	});
});

describe('responsesBody', () => {
	const base = { messages: [{ role: 'user' as const, content: 'hi' }] };

	it('never stores, and asks for encrypted reasoning from a reasoning model', () => {
		const body = responsesBody({ ...base, modelKey: 'gpt-5.6-terra' }, true);
		expect(body.store).toBe(false);
		expect(body.include).toEqual(['reasoning.encrypted_content']);
		expect(body.stream).toBe(true);
	});

	it('sends no include to a model it does not know reasons', () => {
		const body = responsesBody({ ...base, modelKey: 'gpt-4.1' }, false);
		expect(body.include).toBeUndefined();
	});

	it('sends reasoning effort only when asked', () => {
		expect(responsesBody({ ...base, modelKey: 'gpt-5.6-sol' }, false).reasoning).toBeUndefined();
		expect(
			responsesBody({ ...base, modelKey: 'gpt-5.6-sol', reasoning: 'low' }, false).reasoning
		).toEqual({ effort: 'low' });
	});

	it('drops temperature for a reasoning model and keeps it otherwise', () => {
		expect(
			responsesBody({ ...base, modelKey: 'gpt-5.6-sol', temperature: 0.2 }, false).temperature
		).toBeUndefined();
		expect(responsesBody({ ...base, modelKey: 'gpt-4.1', temperature: 0.2 }, false).temperature).toBe(
			0.2
		);
	});

	it('flattens tool definitions and maps the output cap', () => {
		const body = responsesBody(
			{
				...base,
				modelKey: 'gpt-5.6-luna',
				maxTokens: 500,
				tools: [{ name: 'glob', description: 'find', parameters: { type: 'object' } }]
			},
			false
		);
		expect(body.max_output_tokens).toBe(500);
		expect(body.tools).toEqual([
			{ type: 'function', name: 'glob', description: 'find', parameters: { type: 'object' }, strict: false }
		]);
	});
});

describe('readResponsesUsage', () => {
	it('maps the Responses fields and prices the cache discount from the known rates', () => {
		const usage = readResponsesUsage(
			{
				input_tokens: 1_000_000,
				output_tokens: 2000,
				input_tokens_details: { cached_tokens: 800_000 },
				output_tokens_details: { reasoning_tokens: 1500 }
			},
			'gpt-5.6-terra'
		);
		expect(usage.promptTokens).toBe(1_000_000);
		expect(usage.completionTokens).toBe(2000);
		expect(usage.cachedPromptTokens).toBe(800_000);
		expect(usage.reasoningTokens).toBe(1500);
		// 800k cached tokens at $2.00 less $0.20.
		expect(usage.cacheDiscountUsd).toBeCloseTo(1.44);
	});

	it('leaves the optional fields out when the provider said nothing', () => {
		expect(readResponsesUsage({ input_tokens: 5, output_tokens: 1 }, 'gpt-5.6-terra')).toEqual({
			promptTokens: 5,
			completionTokens: 1
		});
	});
});

describe('readResponse', () => {
	it('reads text, finish reason and usage', () => {
		const result = readResponse(
			{
				status: 'completed',
				output: [
					reasoningItem,
					{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }
				],
				usage: { input_tokens: 3, output_tokens: 2 }
			},
			'gpt-5.6-terra'
		);
		expect(result).toMatchObject({ text: 'done', finishReason: 'stop', reasonedOnly: false });
		expect(result.usage).toEqual({ promptTokens: 3, completionTokens: 2 });
	});

	it('reports a model that thought until its cap as length with nothing but reasoning', () => {
		const result = readResponse(
			{
				status: 'incomplete',
				incomplete_details: { reason: 'max_output_tokens' },
				output: [reasoningItem]
			},
			'gpt-5.6-terra'
		);
		expect(result).toMatchObject({ text: '', finishReason: 'length', reasonedOnly: true });
	});
});

describe('parseResponsesStream', () => {
	it('yields text deltas, usage and a stop', async () => {
		const events = await collect(
			streamOf(
				event({ type: 'response.created', response: {} }),
				event({ type: 'response.output_text.delta', delta: 'Hel' }),
				event({ type: 'response.output_text.delta', delta: 'lo' }),
				event({
					type: 'response.completed',
					response: { status: 'completed', usage: { input_tokens: 10, output_tokens: 2 } }
				})
			)
		);
		expect(events).toEqual([
			{ type: 'text', delta: 'Hel' },
			{ type: 'text', delta: 'lo' },
			{ type: 'usage', usage: { promptTokens: 10, completionTokens: 2 } },
			{ type: 'done', finishReason: 'stop' }
		]);
	});

	it('emits parallel tool calls whole, with the items to replay ahead of them', async () => {
		const second = { ...callItem, id: 'fc_2', call_id: 'call_2', arguments: '{"path":"b.ts"}' };
		const events = await collect(
			streamOf(
				event({ type: 'response.output_item.done', item: reasoningItem }),
				event({ type: 'response.function_call_arguments.delta', delta: '{"pa' }),
				event({ type: 'response.output_item.done', item: callItem }),
				event({ type: 'response.output_item.done', item: second }),
				event({ type: 'response.completed', response: { status: 'completed' } })
			)
		);
		expect(events).toEqual([
			{ type: 'provider_items', items: [reasoningItem, callItem, second] },
			{
				type: 'tool_calls',
				calls: [
					{ id: 'call_1', name: 'read_file', arguments: '{"path":"a.ts"}' },
					{ id: 'call_2', name: 'read_file', arguments: '{"path":"b.ts"}' }
				]
			},
			{ type: 'done', finishReason: 'tool_calls' }
		]);
	});

	it('carries no provider items on a reply that ends the leg', async () => {
		const events = await collect(
			streamOf(
				event({ type: 'response.output_item.done', item: reasoningItem }),
				event({ type: 'response.output_text.delta', delta: 'ok' }),
				event({ type: 'response.completed', response: { status: 'completed' } })
			)
		);
		expect(events.map((e) => e.type)).toEqual(['text', 'done']);
	});

	it('surfaces reasoning summaries on the reasoning channel', async () => {
		const events = await collect(
			streamOf(
				event({ type: 'response.reasoning_summary_text.delta', delta: 'thinking' }),
				event({ type: 'response.completed', response: { status: 'completed' } })
			)
		);
		expect(events[0]).toEqual({ type: 'reasoning', delta: 'thinking' });
	});

	it('treats argument deltas, event lines and keep-alives as progress', async () => {
		const events = await collectAll(
			streamOf(
				': keep-alive\n\n',
				event({ type: 'response.function_call_arguments.delta', delta: '{"a":' }),
				event({ type: 'response.completed', response: { status: 'completed' } })
			)
		);
		const progress = events.filter((e) => e.type === 'progress').length;
		// The comment, both event: lines, and the delta itself.
		expect(progress).toBeGreaterThanOrEqual(4);
	});

	it('reports an output cap as length', async () => {
		const events = await collect(
			streamOf(
				event({
					type: 'response.incomplete',
					response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }
				})
			)
		);
		expect(events).toEqual([{ type: 'done', finishReason: 'length' }]);
	});

	it('throws a failed response as a retryable error when the code says so', async () => {
		const run = collect(
			streamOf(
				event({
					type: 'response.failed',
					response: { status: 'failed', error: { code: 'server_error', message: 'boom' } }
				})
			)
		);
		await expect(run).rejects.toBeInstanceOf(ProviderHttpError);
		await expect(run).rejects.toMatchObject({ status: 500 });
	});

	it('maps a rate-limit error event to 429', async () => {
		const run = collect(
			streamOf(event({ type: 'error', code: 'rate_limit_exceeded', message: 'slow down' }))
		);
		await expect(run).rejects.toMatchObject({ status: 429 });
	});
});

describe('createOpenAiResponsesAdapter', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('imports only the models it can price, with their capabilities', async () => {
		const fetchMock = vi.fn(async () =>
			Response.json({
				data: [{ id: 'gpt-5.6-sol' }, { id: 'gpt-5.6-luna-2026-07-30' }, { id: 'whisper-1' }]
			})
		);
		vi.stubGlobal('fetch', fetchMock);
		const adapter = createOpenAiResponsesAdapter({ baseUrl: 'https://api.test/v1', apiKey: 'k' });
		const models = await adapter.listModels();
		expect(models.map((m) => [m.key, m.displayName])).toEqual([
			['gpt-5.6-sol', 'GPT-5.6 Sol'],
			['gpt-5.6-luna-2026-07-30', 'GPT-5.6 Luna (2026-07-30)']
		]);
		expect(models[0]).toMatchObject({
			supportsTools: true,
			supportsReasoning: true,
			promptCostPerMTok: 5,
			completionCostPerMTok: 30
		});
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('https://api.test/v1/models');
		expect((init.headers as Record<string, string>).authorization).toBe('Bearer k');
	});

	it('posts to /responses and throws the status on failure', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('nope', { status: 401 }))
		);
		const adapter = createOpenAiResponsesAdapter({ baseUrl: 'https://api.test/v1' });
		await expect(
			adapter.complete({ modelKey: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'hi' }] })
		).rejects.toMatchObject({ status: 401 });
	});
});
