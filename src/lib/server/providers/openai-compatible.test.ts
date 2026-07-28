import { describe, it, expect } from 'vitest';
import { parseChatCompletionStream } from './openai-compatible';
import type { StreamEvent } from './types';

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

async function collect(stream: ReadableStream<Uint8Array>): Promise<StreamEvent[]> {
	const events: StreamEvent[] = [];
	for await (const ev of parseChatCompletionStream(stream)) events.push(ev);
	return events;
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
