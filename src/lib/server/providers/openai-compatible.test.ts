import { afterEach, describe, it, expect, vi } from 'vitest';
import {
	createOpenAiCompatAdapter,
	defaultCacheMode,
	parseChatCompletionStream,
	readUsage,
	withCacheBreakpoints
} from './openai-compatible';
import type { ProviderMessage, StreamEvent } from './types';

function streamOf(...lines: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			for (const line of lines) controller.enqueue(encoder.encode(line));
			controller.close();
		}
	});
}

const chunk = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;

async function collectAll(stream: ReadableStream<Uint8Array>): Promise<StreamEvent[]> {
	const events: StreamEvent[] = [];
	for await (const ev of parseChatCompletionStream(stream)) events.push(ev);
	return events;
}

/**
 * The events that carry meaning. `progress` says only "the provider is alive"
 * and is emitted from several places, so the tests about *content* filter it
 * out and the tests about liveness look for it directly.
 */
async function collect(stream: ReadableStream<Uint8Array>): Promise<StreamEvent[]> {
	return (await collectAll(stream)).filter((e) => e.type !== 'progress');
}

describe('parseChatCompletionStream', () => {
	it('yields text deltas and usage', async () => {
		const events = await collect(
			streamOf(
				chunk({ choices: [{ delta: { content: 'Hel' } }] }),
				chunk({ choices: [{ delta: { content: 'lo' }, finish_reason: 'stop' }] }),
				chunk({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } }),
				'data: [DONE]\n\n'
			)
		);
		expect(events).toEqual([
			{ type: 'text', delta: 'Hel' },
			{ type: 'text', delta: 'lo' },
			{ type: 'usage', usage: { promptTokens: 10, completionTokens: 2 } },
			{ type: 'done', finishReason: 'stop' }
		]);
	});

	it('accumulates tool-call arguments split across chunks', async () => {
		const events = await collect(
			streamOf(
				chunk({
					choices: [
						{
							delta: {
								tool_calls: [
									{ index: 0, id: 'call_1', function: { name: 'web_search', arguments: '' } }
								]
							}
						}
					]
				}),
				chunk({
					choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"query":"ga' } }] } }]
				}),
				chunk({
					choices: [
						{
							delta: { tool_calls: [{ index: 0, function: { arguments: 'laxy"}' } }] },
							finish_reason: 'tool_calls'
						}
					]
				}),
				'data: [DONE]\n\n'
			)
		);
		expect(events).toContainEqual({
			type: 'tool_calls',
			calls: [{ id: 'call_1', name: 'web_search', arguments: '{"query":"galaxy"}' }]
		});
	});

	it('survives chunk boundaries splitting SSE lines', async () => {
		const full = chunk({ choices: [{ delta: { content: 'split' } }] }) + 'data: [DONE]\n\n';
		const mid = Math.floor(full.length / 2);
		const events = await collect(streamOf(full.slice(0, mid), full.slice(mid)));
		expect(events).toContainEqual({ type: 'text', delta: 'split' });
	});

	it('ignores malformed json lines', async () => {
		const events = await collect(
			streamOf('data: {broken\n\n', chunk({ choices: [{ delta: { content: 'ok' } }] }), 'data: [DONE]\n\n')
		);
		expect(events).toContainEqual({ type: 'text', delta: 'ok' });
	});
});

describe('reasoning models', () => {
	it('surfaces reasoning deltas instead of dropping them', async () => {
		// Dropping these made a model that thinks until its cap look like a run
		// that returned nothing at all.
		const events = await collect(
			streamOf(
				chunk({ choices: [{ delta: { reasoning_content: 'let me think' } }] }),
				chunk({ choices: [{ delta: { content: 'Answer.' }, finish_reason: 'stop' }] }),
				'data: [DONE]\n\n'
			)
		);
		expect(events).toEqual([
			{ type: 'reasoning', delta: 'let me think' },
			{ type: 'text', delta: 'Answer.' },
			{ type: 'done', finishReason: 'stop' }
		]);
	});

	it('accepts the OpenRouter spelling too', async () => {
		const events = await collect(
			streamOf(chunk({ choices: [{ delta: { reasoning: 'hmm' } }] }), 'data: [DONE]\n\n')
		);
		expect(events[0]).toEqual({ type: 'reasoning', delta: 'hmm' });
	});

	it('reports a budget spent entirely on reasoning', async () => {
		const events = await collect(
			streamOf(
				chunk({ choices: [{ delta: { reasoning_content: 'thinking' } }] }),
				chunk({ choices: [{ delta: {}, finish_reason: 'length' }] }),
				'data: [DONE]\n\n'
			)
		);
		// No text at all, and the stop reason says why — enough for the caller to
		// distinguish "spent it thinking" from "had nothing to say".
		expect(events.some((e) => e.type === 'text')).toBe(false);
		expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'length' });
	});
});

describe('readUsage', () => {
	it('reads the plain token counts', () => {
		expect(readUsage({ prompt_tokens: 120, completion_tokens: 30 })).toEqual({
			promptTokens: 120,
			completionTokens: 30
		});
	});

	it('leaves the cache fields absent when the provider says nothing', () => {
		// "The provider did not mention caching" and "nothing was cached" are
		// different answers, and only one of them is zero — reporting the first
		// as the second makes caching look enabled and useless.
		const usage = readUsage({ prompt_tokens: 1, completion_tokens: 1 });
		expect(usage.cachedPromptTokens).toBeUndefined();
		expect(usage.cacheDiscountUsd).toBeUndefined();
	});

	it('picks up cached_tokens where the provider reports them', () => {
		const usage = readUsage({
			prompt_tokens: 1000,
			completion_tokens: 40,
			prompt_tokens_details: { cached_tokens: 768 }
		});
		expect(usage.cachedPromptTokens).toBe(768);
	});

	it('keeps a negative cache discount, which is what a cache write looks like', () => {
		// Writing the cache costs more than plain input; later reads turn it
		// positive. Clamping this at zero would hide half the picture.
		expect(readUsage({ prompt_tokens: 1, completion_tokens: 1, cache_discount: -0.004 }))
			.toHaveProperty('cacheDiscountUsd', -0.004);
	});

	it('ignores a field that is not a number', () => {
		const usage = readUsage({
			prompt_tokens: '12' as unknown as number,
			prompt_tokens_details: { cached_tokens: null }
		});
		expect(usage.promptTokens).toBe(0);
		expect(usage.cachedPromptTokens).toBeUndefined();
	});
});

describe('defaultCacheMode', () => {
	it('starts Anthropic and Gemini on explicit, since they need a breakpoint', () => {
		expect(defaultCacheMode('anthropic/claude-sonnet-4')).toBe('explicit');
		expect(defaultCacheMode('google/gemini-2.5-pro')).toBe('explicit');
	});

	it('leaves everything else on auto, which sends nothing', () => {
		// The safe default: an unknown field is the one way this feature can
		// break a setup that was working.
		expect(defaultCacheMode('z-ai/glm-4.6')).toBe('auto');
		expect(defaultCacheMode('deepseek/deepseek-chat')).toBe('auto');
		expect(defaultCacheMode('some-local-model')).toBe('auto');
	});
});

describe('withCacheBreakpoints', () => {
	const convo: ProviderMessage[] = [
		{ role: 'system', content: 'BASE' },
		{ role: 'user', content: 'first' },
		{ role: 'assistant', content: 'reply' },
		{ role: 'user', content: 'second' }
	];
	const marked = (m: ProviderMessage) =>
		Array.isArray(m.content) &&
		(m.content[0] as unknown as { cache_control?: unknown }).cache_control !== undefined;

	it('changes nothing at all on auto', () => {
		expect(withCacheBreakpoints(convo, 'auto')).toBe(convo);
		expect(withCacheBreakpoints(convo, undefined)).toBe(convo);
		expect(withCacheBreakpoints(convo, 'none')).toBe(convo);
	});

	it('marks the system prompt and the newest settled message', () => {
		const out = withCacheBreakpoints(convo, 'explicit');
		expect(marked(out[0])).toBe(true);
		expect(marked(out[2])).toBe(true);
	});

	it('leaves the final message outside the cached prefix', () => {
		// It is the one that changed; there is nothing behind it to reuse.
		expect(marked(withCacheBreakpoints(convo, 'explicit')[3])).toBe(false);
	});

	it('keeps the text intact where it marks', () => {
		const out = withCacheBreakpoints(convo, 'explicit');
		expect(out[0].content).toEqual([
			{ type: 'text', text: 'BASE', cache_control: { type: 'ephemeral' } }
		]);
	});

	it('skips a tool result rather than rewriting its shape', () => {
		// Not every gateway accepts a tool message rewritten into content parts,
		// and a cache marker is never worth risking the call over.
		const withTool: ProviderMessage[] = [
			{ role: 'system', content: 'BASE' },
			{ role: 'assistant', content: '', tool_calls: [{ id: 't1', name: 'read', arguments: '{}' }] },
			{ role: 'tool', content: 'file contents', tool_call_id: 't1' },
			{ role: 'user', content: 'go on' }
		];
		const out = withCacheBreakpoints(withTool, 'explicit');
		expect(marked(out[1])).toBe(false);
		expect(marked(out[2])).toBe(false);
		expect(out[2].content).toBe('file contents');
		// The system prompt is still worth marking on its own.
		expect(marked(out[0])).toBe(true);
	});

	it('handles a single-message request without marking it', () => {
		const one: ProviderMessage[] = [{ role: 'system', content: 'BASE' }];
		expect(marked(withCacheBreakpoints(one, 'explicit')[0])).toBe(true);
		expect(withCacheBreakpoints([], 'explicit')).toEqual([]);
	});
});

/**
 * Everything here is about the idle watchdog in loop.ts, which re-arms on any
 * event a stream yields. A provider that is plainly working must never look
 * silent to it — that is what killed a coding turn at ninety seconds while the
 * model was mid-way through writing a file.
 */
describe('reporting that the provider is alive', () => {
	const progressCount = (events: StreamEvent[]) =>
		events.filter((e) => e.type === 'progress').length;

	it('reports every tool-call fragment, not just the finished batch', async () => {
		// The batch is only emitted once the stream ends. Without this the whole
		// of a large write_file payload is invisible for as long as it takes to
		// arrive, which for a coding model is the longest output there is.
		const fragment = (args: string) =>
			chunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args } }] } }] });
		const events = await collectAll(
			streamOf(
				chunk({
					choices: [
						{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'write_file' } }] } }
					]
				}),
				fragment('{"path":'),
				fragment('"a.ts",'),
				fragment('"content":"x"}'),
				chunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
				'data: [DONE]\n\n'
			)
		);
		// One per fragment-bearing chunk, and the call still arrives intact.
		expect(progressCount(events)).toBe(4);
		expect(events.filter((e) => e.type === 'tool_calls')).toEqual([
			{
				type: 'tool_calls',
				calls: [
					{ id: 'c1', name: 'write_file', arguments: '{"path":"a.ts","content":"x"}' }
				]
			}
		]);
	});

	it('reports a keep-alive comment, which used to be thrown away', async () => {
		// OpenRouter sends these through a long upstream wait for exactly this
		// purpose, and the reader dropped every line that was not `data:`.
		const events = await collectAll(
			streamOf(': OPENROUTER PROCESSING\n\n', chunk({ choices: [{ delta: { content: 'hi' } }] }), 'data: [DONE]\n\n')
		);
		expect(progressCount(events)).toBe(1);
		expect(events.filter((e) => e.type === 'text')).toEqual([{ type: 'text', delta: 'hi' }]);
	});

	it('reports a chunk it cannot parse rather than ignoring it', async () => {
		const events = await collectAll(streamOf('data: {not json\n\n', 'data: [DONE]\n\n'));
		expect(progressCount(events)).toBe(1);
	});

	it('reports a choice-less chunk', async () => {
		const events = await collectAll(
			streamOf(chunk({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }), 'data: [DONE]\n\n')
		);
		expect(progressCount(events)).toBe(1);
	});

	it('says nothing extra for an ordinary text delta', async () => {
		// text already re-arms the watchdog; a second event per token would be
		// noise on the hot path.
		const events = await collectAll(
			streamOf(chunk({ choices: [{ delta: { content: 'hi' } }] }), 'data: [DONE]\n\n')
		);
		expect(progressCount(events)).toBe(0);
	});
});

/**
 * Image generation, which rides the ordinary chat-completions call: the request
 * asks for the image modality and the reply carries data URLs alongside the
 * text. Driven through the adapter with a stubbed fetch, since the parsing and
 * the request body are the two halves that have to agree.
 */
describe('image output', () => {
	const PIXEL = 'iVBORw0KGgoAAAANSUhEUg==';
	let sent: Record<string, unknown> = {};

	function adapterReturning(body: unknown) {
		vi.stubGlobal('fetch', async (_url: string, init: RequestInit = {}) => {
			// listModels is a GET with no body; only a completion has one to read.
			if (init.body) sent = JSON.parse(String(init.body));
			return new Response(JSON.stringify(body), {
				headers: { 'content-type': 'application/json' }
			});
		});
		return createOpenAiCompatAdapter({ baseUrl: 'https://example.test/v1' });
	}

	afterEach(() => vi.unstubAllGlobals());

	it('sends modalities only when they are asked for', async () => {
		const adapter = adapterReturning({ choices: [{ message: { content: 'hi' } }] });
		await adapter.complete({ modelKey: 'm', messages: [] });
		expect(sent.modalities).toBeUndefined();
		await adapter.complete({ modelKey: 'm', messages: [], modalities: ['image', 'text'] });
		expect(sent.modalities).toEqual(['image', 'text']);
	});

	it('decodes the images off the message', async () => {
		const adapter = adapterReturning({
			choices: [
				{
					message: {
						content: 'here you go',
						images: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${PIXEL}` } }]
					}
				}
			]
		});
		const res = await adapter.complete({ modelKey: 'm', messages: [], modalities: ['image'] });
		expect(res.images).toEqual([{ mime: 'image/png', base64: PIXEL }]);
	});

	it('keeps the images it can read and drops the ones it cannot', async () => {
		const adapter = adapterReturning({
			choices: [
				{
					message: {
						images: [
							{ image_url: { url: 'https://example.test/not-a-data-url.png' } },
							{ image_url: { url: `data:image/webp;base64,${PIXEL}` } },
							{ nothing: true }
						]
					}
				}
			]
		});
		const res = await adapter.complete({ modelKey: 'm', messages: [] });
		expect(res.images).toEqual([{ mime: 'image/webp', base64: PIXEL }]);
	});

	it('leaves images absent on an ordinary reply', async () => {
		const adapter = adapterReturning({ choices: [{ message: { content: 'just words' } }] });
		expect((await adapter.complete({ modelKey: 'm', messages: [] })).images).toBeUndefined();
	});

	it('reads image generation off the listing, as the mirror of vision', async () => {
		const adapter = adapterReturning({
			data: [
				{
					id: 'vendor/painter',
					architecture: { input_modalities: ['text'], output_modalities: ['text', 'image'] }
				},
				{ id: 'vendor/talker', architecture: { input_modalities: ['text', 'image'] } }
			]
		});
		const models = await adapter.listModels();
		expect(models.map((m) => [m.key, m.supportsImageOutput, m.supportsVision])).toEqual([
			['vendor/painter', true, false],
			['vendor/talker', false, true]
		]);
	});
});
