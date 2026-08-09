import { afterEach, describe, expect, it } from 'vitest';
import type {
	ChatRequest,
	ProviderAdapter,
	ProviderMessage,
	StreamEvent
} from '$lib/server/providers/types';
import { isRetryable, StreamTimeoutError } from '$lib/server/providers/types';
import { isCancellation } from './jobs';
import { elideOldToolOutput, isNarration, stepLabel, streamWithIdleTimeout } from './loop';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Adapter that emits `count` deltas `gap`ms apart, then optionally hangs. */
function fakeAdapter(opts: { count: number; gap: number; hangAfter?: boolean }): ProviderAdapter {
	return {
		async *stream(_req: ChatRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
			for (let i = 0; i < opts.count; i++) {
				await sleep(opts.gap);
				if (signal?.aborted) throw signal.reason;
				yield { type: 'text', delta: `chunk${i}` };
			}
			if (opts.hangAfter) {
				// Stall exactly the way a wedged provider connection does: nothing
				// arrives, and only the abort ends the wait.
				await new Promise((_, reject) => {
					signal?.addEventListener('abort', () => reject(signal.reason));
				});
			}
		},
		complete: async () => ({ text: '', usage: null }),
		listModels: async () => []
	};
}

const collect = async (gen: AsyncGenerator<StreamEvent>) => {
	const out: StreamEvent[] = [];
	for await (const ev of gen) out.push(ev);
	return out;
};

const req: ChatRequest = { modelKey: 'm', messages: [], tools: [] };

afterEach(() => {
	delete process.env.STREAM_IDLE_TIMEOUT_MS;
	delete process.env.STREAM_TOTAL_TIMEOUT_MS;
});

describe('streamWithIdleTimeout', () => {
	it('lets a slow but active stream run well past the idle window', async () => {
		process.env.STREAM_IDLE_TIMEOUT_MS = '80';
		// Total run is ~200ms — more than double the idle timeout. Under the old
		// total deadline this is exactly the shape that died mid-answer.
		const events = await collect(
			streamWithIdleTimeout(fakeAdapter({ count: 10, gap: 20 }), req, new AbortController().signal)
		);
		expect(events).toHaveLength(10);
	});

	it('aborts once the stream actually goes quiet', async () => {
		process.env.STREAM_IDLE_TIMEOUT_MS = '60';
		const gen = streamWithIdleTimeout(
			fakeAdapter({ count: 2, gap: 10, hangAfter: true }),
			req,
			new AbortController().signal
		);
		await expect(collect(gen)).rejects.toThrow(StreamTimeoutError);
	});

	it('enforces the absolute ceiling even while output keeps arriving', async () => {
		process.env.STREAM_IDLE_TIMEOUT_MS = '1000';
		process.env.STREAM_TOTAL_TIMEOUT_MS = '60';
		const gen = streamWithIdleTimeout(
			fakeAdapter({ count: 100, gap: 10 }),
			req,
			new AbortController().signal
		);
		await expect(collect(gen)).rejects.toThrow(StreamTimeoutError);
	});

	it('still surfaces a user stop as a cancellation, not a timeout', async () => {
		process.env.STREAM_IDLE_TIMEOUT_MS = '5000';
		const job = new AbortController();
		const gen = streamWithIdleTimeout(fakeAdapter({ count: 100, gap: 10 }), req, job.signal);
		setTimeout(() => job.abort(), 30);
		await expect(collect(gen)).rejects.toBeDefined();
		expect(job.signal.aborted).toBe(true);
	});
});

describe('timeout classification', () => {
	it('is retryable, so a stalled call fails over instead of ending the run', () => {
		expect(isRetryable(new StreamTimeoutError('quiet'))).toBe(true);
	});

	it('is not mistaken for the user pressing stop', () => {
		// The distinction matters: a cancellation keeps the partial reply and
		// finishes normally, which would silently truncate a stalled answer.
		expect(isCancellation(new StreamTimeoutError('quiet'))).toBe(false);
	});
});

describe('isNarration', () => {
	it('accepts the one-line lead-in the prompt asks for', () => {
		expect(isNarration('Checking how the loop handles a cancelled turn.')).toBe(true);
		expect(isNarration('Reading src/lib/loop.ts and src/lib/jobs.ts now')).toBe(true);
		expect(isNarration('')).toBe(true);
	});

	it('refuses a drafted email, which is the reply and not a label', () => {
		// The regression this exists for: the model redrafts an email, calls a
		// tool in the same message, and the draft is silently dropped — leaving
		// the user a reply that only says the work was done.
		const email = [
			'Hi Sam,',
			'',
			'Thanks for sending the proposal over. I have read it and I think the',
			'scope is right, but the timeline needs another two weeks.',
			'',
			'Best,',
			'Alex'
		].join('\n');
		expect(isNarration(email)).toBe(false);
	});

	it('refuses anything long, multi-paragraph, or holding code', () => {
		expect(isNarration('x'.repeat(201))).toBe(false);
		expect(isNarration('First thought.\n\nSecond thought.')).toBe(false);
		expect(isNarration('Here it is:\n```\nconst x = 1;\n```')).toBe(false);
		expect(isNarration('one\ntwo\nthree')).toBe(false);
	});

	it('allows a lead-in that wrapped onto a second line', () => {
		expect(isNarration('Checking the loop,\nthen the session file.')).toBe(true);
	});
});

describe('stepLabel', () => {
	const FALLBACK = 'read_file src/lib/loop.ts';

	it('takes the first line of the narration', () => {
		expect(stepLabel('Checking how cancellation is handled.\n\nThen I will…', FALLBACK)).toBe(
			'Checking how cancellation is handled.'
		);
	});

	it('strips the bullet and bold marks models lead with', () => {
		expect(stepLabel('- **Reading the loop**', FALLBACK)).toBe('Reading the loop');
		expect(stepLabel('## Reading the loop', FALLBACK)).toBe('Reading the loop');
	});

	it('falls back to the tool call when the model narrated nothing', () => {
		// The prompt asks for a narration line but must never depend on it.
		expect(stepLabel('', FALLBACK)).toBe(FALLBACK);
		expect(stepLabel('   \n\n  ', FALLBACK)).toBe(FALLBACK);
	});

	it('prefers a whole first sentence over a hard cut', () => {
		const long = `I am going to read the loop. ${'x'.repeat(200)}`;
		expect(stepLabel(long, FALLBACK)).toBe('I am going to read the loop.');
	});

	it('truncates when even the first sentence is too long', () => {
		const label = stepLabel('y'.repeat(300), FALLBACK);
		expect(label).toHaveLength(100);
		expect(label.endsWith('…')).toBe(true);
	});
});

describe('elideOldToolOutput', () => {
	const toolMsg = (content: string): ProviderMessage => ({
		role: 'tool',
		content,
		tool_call_id: 't'
	});

	it('leaves a transcript under budget untouched', () => {
		const messages: ProviderMessage[] = [toolMsg('a'.repeat(50)), toolMsg('b'.repeat(50))];
		expect(elideOldToolOutput(messages, 1000)).toBe(0);
		expect(messages[0].content).toBe('a'.repeat(50));
	});

	it('drops the oldest results first and keeps the newest intact', () => {
		const messages: ProviderMessage[] = [
			toolMsg('a'.repeat(500)),
			toolMsg('b'.repeat(500)),
			toolMsg('c'.repeat(500))
		];
		const dropped = elideOldToolOutput(messages, 700);
		expect(dropped).toBeGreaterThan(0);
		expect(messages[0].content).not.toContain('aaa');
		expect(messages[2].content).toBe('c'.repeat(500));
	});

	it('does not touch non-tool messages', () => {
		const messages: ProviderMessage[] = [
			{ role: 'system', content: 's'.repeat(900) },
			{ role: 'user', content: 'u'.repeat(900) },
			toolMsg('t'.repeat(900))
		];
		elideOldToolOutput(messages, 10);
		expect(messages[0].content).toBe('s'.repeat(900));
		expect(messages[1].content).toBe('u'.repeat(900));
	});

	it('is stable when called again with nothing left to shed', () => {
		const messages: ProviderMessage[] = [toolMsg('a'.repeat(500)), toolMsg('b'.repeat(500))];
		elideOldToolOutput(messages, 200);
		const after = messages.map((m) => m.content);
		// A second pass must not spin: everything droppable is already dropped.
		elideOldToolOutput(messages, 200);
		expect(messages.map((m) => m.content)).toEqual(after);
	});
});
