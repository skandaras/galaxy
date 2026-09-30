import { randomUUID } from 'node:crypto';
import type { LoopTool } from './loop';
import type { ToolDef } from '$lib/server/providers/types';
import { pushChunk, type LiveJob } from './jobs';
import { notify, resolveEntity } from '$lib/server/notifications';
import { listAttachments } from '$lib/server/chats';
import { withDocumentText } from './context';

/**
 * Letting an agent stop and ask.
 *
 * This works because a job is an in-memory object with a subscriber set and a
 * tool's `execute` is async: the tool pushes a `question` chunk, hands back a
 * promise, and the loop simply waits. The browser answers over a normal POST,
 * which resolves the promise, and the turn carries on with the answer as the
 * tool result.
 *
 * The wait is unbounded. It used to give up after ten minutes and tell the
 * model nobody was watching, which meant a question asked while you were away
 * from the screen was answered by nobody and the run carried on guessing — the
 * one outcome asking was supposed to prevent. A parked run now waits for an
 * answer or for you to press Stop, and nothing else ends it.
 *
 * Nothing here is persisted. A question is only meaningful while the run that
 * asked it is alive, and a server restart loses it exactly as it loses any
 * other in-flight job.
 */

/** Options are a convenience for the person answering, not a constraint. */
const MAX_OPTIONS = 6;

interface Pending {
	jobId: string;
	userId: string;
	settle: (answer: string, note?: string) => void;
}

const pending = new Map<string, Pending>();

export const askUserToolDef: ToolDef = {
	name: 'ask_user',
	description:
		'Ask the person you are working for a question and wait for their answer. Use this when you are missing something only they can tell you, or when you have hit a blocker they should know about. Not to check in, confirm the obvious, or narrate progress. Ask one focused question at a time. If you can reasonably work it out yourself, do that instead. The run parks until they answer, however long that takes, so only ask when the answer is worth waiting for.',
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
			// The run is doing work again, so the watchdog applies again.
			job.parked = false;
			job.controller.signal.removeEventListener('abort', onAbort);
			// Always close the question on the stream, however it ended, so a
			// reconnecting client doesn't reopen a sheet nobody can answer.
			pushChunk(job, { type: 'answer', id, text: note ?? answer });
			// And clear the bell, however it ended — a badge still demanding an
			// answer to a question that has been dealt with teaches people to
			// ignore it.
			resolveEntity(id, job.userId);
			resolve(answer);
		};

		// A stopped run must not leave the loop parked on a promise; the loop
		// winds down at its next check once this returns. With no timeout, this
		// is the only way out other than answering.
		const onAbort = () => finish('The run was stopped before this was answered.', '(run stopped)');
		job.controller.signal.addEventListener('abort', onAbort, { once: true });

		pending.set(id, { jobId: job.id, userId: job.userId, settle: (answer, note) => finish(answer, note) });
		// Set before the chunk, so a job read the instant the question lands is
		// already exempt from the staleness watchdog. A parked job produces no
		// chunks by definition, which is exactly what the watchdog looks for.
		job.parked = true;
		pushChunk(job, { type: 'question', id, prompt, options });

		// The only notification urgent enough to wake a phone: the run is parked
		// until this is answered, and it will wait indefinitely. Anyone not
		// looking at this exact chat has no other way to find out.
		notify({
			userId: job.userId,
			kind: 'question',
			title: 'An agent needs an answer',
			body: prompt,
			link: `/chat?chat=${job.chatId}`,
			entityId: id,
			urgent: true
		});
	});
}

/**
 * What the model is told when the person closes the question instead of
 * answering it. The sheet used to have no way out at all, only a hint pointing
 * at a Stop button it was drawn on top of.
 */
export const SKIPPED_ANSWER =
	'They closed this question without answering. Carry on with your best judgement, and say in your reply what you assumed in place of an answer.';

/**
 * An answer with files attached to it, as the tool result the model reads and
 * the short note the stream carries.
 *
 * The files are uploaded to the chat first, through the same endpoint as the
 * composer's, so the ids are looked up against this chat alone and an id from
 * anywhere else is dropped. Documents are inlined with the same labelled block
 * a message attachment gets; a tool result is text, so an image is pointed at
 * view_image rather than shown. The note keeps the extracted text off the
 * stream, which only needs to close the question.
 */
export function composeAnswer(
	chatId: string,
	text: string,
	attachmentIds: string[]
): { answer: string; note: string; attached: number } {
	const wanted = new Set(attachmentIds);
	const files = listAttachments(chatId).filter((a) => wanted.has(a.id));
	const docs = files.filter((a) => a.kind === 'document');
	let answer = withDocumentText(chatId, text, docs);
	for (const img of files.filter((a) => a.kind === 'image')) {
		answer += `\n\n[Attached image: ${img.name} (${img.mime}). Call view_image with id="${img.id}" to see it.]`;
	}
	const note = [text, ...files.map((a) => `📎 ${a.name}`)].filter(Boolean).join(' ');
	return { answer: answer.trim(), note, attached: files.length };
}

/**
 * Answer an open question. Returns false when there is nothing to answer —
 * already answered, the run was stopped, or it was never asked — which the
 * client treats as a lost race rather than an error.
 */
export function answerQuestion(
	questionId: string,
	userId: string,
	answer: string,
	note?: string
): boolean {
	const entry = pending.get(questionId);
	// Same shape as an unknown question, so ids can't be probed for existence.
	if (!entry || entry.userId !== userId) return false;
	entry.settle(answer, note);
	return true;
}

/** Test seam: questions still waiting, for assertions about cleanup. */
export function openQuestionCount(): number {
	return pending.size;
}
