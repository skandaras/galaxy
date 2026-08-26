import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '$lib/server/db';
import { answerQuestion, askUserTool, openQuestionCount } from './ask-user';
import { createJob, subscribeJob, type JobChunk, type LiveJob } from './jobs';

beforeAll(() => {
	runMigrations();
});

/**
 * The pending map is module-global, exactly as it is in production — so a test
 * that walks away from an open question would leak it into the next one's
 * count. Aborting each job settles whatever it left waiting.
 */
const opened: LiveJob[] = [];

afterEach(() => {
	for (const job of opened.splice(0)) job.controller.abort();
	vi.useRealTimers();
	expect(openQuestionCount()).toBe(0);
});

function harness(userId = 'u1') {
	const job = createJob({ chatId: 'c1', userId, task: 'chat', persist: false });
	const chunks: JobChunk[] = [];
	subscribeJob(job, (c) => chunks.push(c));
	opened.push(job);
	return { job, chunks, tool: askUserTool(job) };
}

const questionIn = (chunks: JobChunk[]) =>
	chunks.find((c) => c.type === 'question') as Extract<JobChunk, { type: 'question' }>;

describe('asking', () => {
	it('puts the question on the stream and waits', async () => {
		const { chunks, tool } = harness();
		const pending = tool.execute({ question: 'Which account?', options: ['Joint', 'Mine'] });

		const asked = questionIn(chunks);
		expect(asked.prompt).toBe('Which account?');
		expect(asked.options).toEqual(['Joint', 'Mine']);
		// Still waiting: nothing has resolved it yet.
		expect(openQuestionCount()).toBe(1);

		answerQuestion(asked.id, 'u1', 'The joint one');
		await expect(pending).resolves.toBe('The joint one');
	});

	it('closes the question on the stream, so a replay does not reopen it', async () => {
		const { chunks, tool } = harness();
		const pending = tool.execute({ question: 'Which account?' });
		const asked = questionIn(chunks);

		answerQuestion(asked.id, 'u1', 'The joint one');
		await pending;

		const closed = chunks.find((c) => c.type === 'answer');
		expect(closed).toEqual({ type: 'answer', id: asked.id, text: 'The joint one' });
	});

	it('refuses an empty question rather than parking the run on nothing', async () => {
		const { tool } = harness();
		await expect(tool.execute({ question: '   ' })).rejects.toThrow('question is required');
	});

	it('caps the options offered', async () => {
		const { chunks, tool } = harness();
		void tool.execute({
			question: 'Pick',
			options: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
		});
		expect(questionIn(chunks).options).toHaveLength(6);
	});
});

describe('who may answer', () => {
	it('ignores an answer from another user', async () => {
		const { chunks, tool } = harness('alice');
		void tool.execute({ question: 'Which account?' });
		const asked = questionIn(chunks);

		expect(answerQuestion(asked.id, 'bob', 'mine')).toBe(false);
		// Still open — bob's attempt did not resolve alice's run.
		expect(openQuestionCount()).toBe(1);
		expect(answerQuestion(asked.id, 'alice', 'mine')).toBe(true);
	});

	it('reports an unknown or already-answered question as false', async () => {
		const { chunks, tool } = harness();
		const pending = tool.execute({ question: 'Which account?' });
		const asked = questionIn(chunks);

		expect(answerQuestion(asked.id, 'u1', 'first')).toBe(true);
		await pending;
		// Losing the race is not an error; the stream already said so.
		expect(answerQuestion(asked.id, 'u1', 'second')).toBe(false);
		expect(answerQuestion('never-asked', 'u1', 'x')).toBe(false);
	});
});

describe('when nobody answers', () => {
	/** Resolves to 'pending' unless the question settled first. */
	const settledYet = (p: Promise<string>) =>
		Promise.race([p, Promise.resolve('pending')]);

	it('waits indefinitely rather than answering on your behalf', async () => {
		vi.useFakeTimers();
		const { job, tool } = harness();
		const pending = tool.execute({ question: 'Which account?' });

		// Well past the ten minutes this used to give up after, and past the
		// 45-minute job watchdog too.
		vi.advanceTimersByTime(6 * 60 * 60 * 1000);
		await vi.runOnlyPendingTimersAsync();

		expect(await settledYet(pending)).toBe('pending');
		expect(openQuestionCount()).toBe(1);
		expect(job.parked).toBe(true);
	});

	it('carries on with the answer whenever it finally arrives', async () => {
		vi.useFakeTimers();
		const { job, chunks, tool } = harness();
		const pending = tool.execute({ question: 'Which account?' });

		vi.advanceTimersByTime(3 * 60 * 60 * 1000);
		await vi.runOnlyPendingTimersAsync();

		const asked = questionIn(chunks);
		expect(answerQuestion(asked.id, 'u1', 'The joint one')).toBe(true);
		await expect(pending).resolves.toBe('The joint one');
		// Working again, so the watchdog applies again.
		expect(job.parked).toBe(false);
	});

	it('settles when the run is stopped, so the loop can wind down', async () => {
		const { job, chunks, tool } = harness();
		const pending = tool.execute({ question: 'Which account?' });

		job.controller.abort();
		await expect(pending).resolves.toContain('stopped');
		expect(openQuestionCount()).toBe(0);
		expect(chunks.find((c) => c.type === 'answer')).toMatchObject({ text: '(run stopped)' });
	});
});

describe('the tool definition', () => {
	it('describes the call by the question, for the trace', () => {
		const { tool } = harness();
		expect(tool.describe?.({ question: 'Which account?' })).toBe('Which account?');
	});

	it('is offered under a name the model will recognise', () => {
		expect(harness().tool.def.name).toBe('ask_user');
	});
});

/** Two runs must not be able to answer each other's questions. */
describe('isolation between runs', () => {
	it('keys questions to their own job', async () => {
		const a = harness('alice');
		const b = harness('alice');
		const pendingA = a.tool.execute({ question: 'A?' });
		void b.tool.execute({ question: 'B?' });

		const askedA = questionIn(a.chunks);
		const askedB = questionIn(b.chunks);
		expect(askedA.id).not.toBe(askedB.id);

		answerQuestion(askedA.id, 'alice', 'answer for A');
		await expect(pendingA).resolves.toBe('answer for A');
		// B is untouched.
		expect(openQuestionCount()).toBe(1);
		answerQuestion(askedB.id, 'alice', 'answer for B');
	});
});

/**
 * Guards the contract the loop depends on: execute resolves with a usable
 * string on every path, and never rejects. A stop is the only path left now
 * that the timeout is gone.
 */
describe('what the model is told', () => {
	it('returns a usable instruction rather than throwing', async () => {
		const { job, tool } = harness();
		const pending = tool.execute({ question: 'Which account?' });

		job.controller.abort();

		await expect(pending).resolves.toMatch(/stopped/);
	});
});
