import { randomUUID } from 'node:crypto';
import type { LoopTool } from './loop';
import type { ToolDef } from '$lib/server/providers/types';
import { pushChunk, type LiveJob } from './jobs';

/**
 * Letting an agent stop and ask.
 *
 * This works because a job is an in-memory object with a subscriber set and a
 * tool's `execute` is async: the tool pushes a `question` chunk, hands back a
 * promise, and the loop simply waits. The browser answers over a normal POST,
 * which resolves the promise, and the turn carries on with the answer as the
 * tool result.
 *
 * Nothing here is persisted. A question is only meaningful while the run that
 * asked it is alive, and a server restart loses it exactly as it loses any
 * other in-flight job.
 */

/** How long a question stays open before the agent is told nobody answered. */
export const ASK_TIMEOUT_MS = 10 * 60 * 1000;

/** Options are a convenience for the person answering, not a constraint. */
const MAX_OPTIONS = 6;

interface Pending {
	jobId: string;
	userId: string;
	settle: (answer: string) => void;
}

const pending = new Map<string, Pending>();

export const askUserToolDef: ToolDef = {
	name: 'ask_user',
	description:
		'Ask the person you are working for a question and wait for their answer. Use this when you are missing something only they can tell you, or when you have hit a blocker they should know about — not to check in, confirm the obvious, or narrate progress. Ask one focused question at a time. If you can reasonably work it out yourself, do that instead.',
	parameters: {
		type: 'object',
		properties: {
			question: {
				type: 'string',
				description: 'The question, in plain language. One question, not a list.'
			},
			options: {
				type: 'array',
				items: { type: 'string' },
				description:
					'Optional suggested answers, offered as buttons. They can still type something else.'
			}
		},
		required: ['question']
	}
};

export function askUserTool(job: LiveJob): LoopTool {
	return {
		def: askUserToolDef,
		describe: (a) => String(a.question ?? ''),
		execute: async (a) => {
			const prompt = String(a.question ?? '').trim();
			if (!prompt) throw new Error('question is required');
			const options = Array.isArray(a.options)
				? a.options.map((o) => String(o).trim()).filter(Boolean).slice(0, MAX_OPTIONS)
				: [];
			return waitForAnswer(job, prompt, options);
		}
	};
}

function waitForAnswer(job: LiveJob, prompt: string, options: string[]): Promise<string> {
	const id = randomUUID();
	return new Promise<string>((resolve) => {
		let done = false;
		const finish = (answer: string, note?: string) => {
			if (done) return;
			done = true;
			pending.delete(id);
			clearTimeout(timer);
			job.controller.signal.removeEventListener('abort', onAbort);
			// Always close the question on the stream, however it ended, so a
			// reconnecting client doesn't reopen a sheet nobody can answer.
			pushChunk(job, { type: 'answer', id, text: note ?? answer });
			resolve(answer);
		};

		const timer = setTimeout(
			() =>
				finish(
					`No answer after ${Math.round(ASK_TIMEOUT_MS / 60000)} minutes — nobody is watching. Do what you safely can without this, and say plainly what you could not settle.`,
					'(no answer — timed out)'
				),
			ASK_TIMEOUT_MS
		);
		timer.unref?.();

		// A stopped run must not leave the loop parked on a promise; the loop
		// winds down at its next check once this returns.
		const onAbort = () => finish('The run was stopped before this was answered.', '(run stopped)');
		job.controller.signal.addEventListener('abort', onAbort, { once: true });

		pending.set(id, { jobId: job.id, userId: job.userId, settle: (answer) => finish(answer) });
		pushChunk(job, { type: 'question', id, prompt, options });
	});
}

/**
 * Answer an open question. Returns false when there is nothing to answer —
 * already answered, timed out, or never asked — which the client treats as a
 * lost race rather than an error.
 */
export function answerQuestion(questionId: string, userId: string, answer: string): boolean {
	const entry = pending.get(questionId);
	// Same shape as an unknown question, so ids can't be probed for existence.
	if (!entry || entry.userId !== userId) return false;
	entry.settle(answer);
	return true;
}

/** Test seam: questions still waiting, for assertions about cleanup. */
export function openQuestionCount(): number {
	return pending.size;
}
