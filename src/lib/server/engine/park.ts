import { randomUUID } from 'node:crypto';
import { pushChunk, type JobChunk, type LiveJob } from './jobs';
import { notify, resolveEntity } from '$lib/server/notifications';

/**
 * Parking a run on a person: the machinery behind `ask_user` and tool
 * permissions.
 *
 * A job is an in-memory object with a subscriber set and a tool's `execute` is
 * async, so a prompt is a chunk pushed to the browser plus a promise the loop
 * waits on. The browser answers over a normal POST, which settles the promise.
 *
 * It was private to ask-user.ts until permissions needed the same wait, the
 * same abort handling and the same bell entry. A second copy would have
 * disagreed with the first about one of the three the first time one of them
 * was fixed.
 *
 * The wait is unbounded, for the reason written up in ask-user.ts: a run that
 * gives up on an absent person carries on guessing, which is the outcome
 * asking exists to prevent.
 */

export type PromptKind = 'question' | 'permission';

interface Pending {
	kind: PromptKind;
	jobId: string;
	userId: string;
	settle: (value: unknown, note?: string) => void;
}

const pending = new Map<string, Pending>();

export interface ParkOptions<T> {
	kind: PromptKind;
	/** The job the browser is attached to: it gets the chunks and the `parked` count. */
	job: LiveJob;
	userId: string;
	/** Builds the chunk that opens the prompt. */
	open: (id: string) => JobChunk;
	/** Builds the chunk that closes it, however it ended. */
	close: (id: string, value: T, note?: string) => JobChunk;
	/** What the waiting call is handed when the run is stopped first. */
	onStop: { value: T; note?: string };
	/** The bell entry and push. `kind` doubles as the notification kind. */
	notice: { title: string; body: string; link: string };
	/**
	 * A second signal that also ends the wait. A nested worker's own controller
	 * can be aborted while the job it prompts on keeps running.
	 */
	signal?: AbortSignal;
}

export function parkOnPrompt<T>(opts: ParkOptions<T>): Promise<T> {
	const { job } = opts;
	const id = randomUUID();
	return new Promise<T>((resolve) => {
		let done = false;
		const signals = [job.controller.signal, ...(opts.signal ? [opts.signal] : [])];
		const finish = (value: T, note?: string) => {
			if (done) return;
			done = true;
			pending.delete(id);
			// The run is doing work again, so the watchdog applies again. Only this
			// prompt's share: another may still be open on the same job.
			job.parked = Math.max(0, (job.parked ?? 0) - 1);
			for (const s of signals) s.removeEventListener('abort', onAbort);
			// Always close the prompt on the stream, however it ended, so a
			// reconnecting client doesn't reopen a sheet nobody can answer.
			pushChunk(job, opts.close(id, value, note));
			// And clear the bell, however it ended: a badge still demanding an
			// answer to something that has been dealt with teaches people to ignore it.
			resolveEntity(id, opts.userId);
			resolve(value);
		};

		// A stopped run must not leave the loop parked on a promise; the loop
		// winds down at its next check once this returns. With no timeout, this
		// is the only way out other than answering.
		const onAbort = () => finish(opts.onStop.value, opts.onStop.note);
		for (const s of signals) s.addEventListener('abort', onAbort, { once: true });

		pending.set(id, {
			kind: opts.kind,
			jobId: job.id,
			userId: opts.userId,
			settle: (value, note) => finish(value as T, note)
		});
		// Set before the chunk, so a job read the instant the prompt lands is
		// already exempt from the staleness watchdog. A parked job produces no
		// chunks by definition, which is exactly what the watchdog looks for.
		job.parked = (job.parked ?? 0) + 1;
		pushChunk(job, opts.open(id));

		// The only notifications urgent enough to wake a phone: the run is parked
		// until this is settled, and it will wait indefinitely. Anyone not looking
		// at this exact chat has no other way to find out.
		//
		// A hidden chat gets the live event and the push but no row. The row's
		// `link` holds the chat id, and a hidden chat's id is stored nowhere.
		notify({
			userId: opts.userId,
			kind: opts.kind,
			title: opts.notice.title,
			body: opts.notice.body,
			link: opts.notice.link,
			entityId: id,
			urgent: true,
			record: job.persist
		});
	});
}

/**
 * Settle an open prompt of this kind. False when there is nothing to settle:
 * already settled, the run was stopped, never asked, someone else's, or the
 * other kind. All the same shape, so ids can't be probed for existence.
 */
export function settlePrompt(
	kind: PromptKind,
	id: string,
	userId: string,
	value: unknown,
	note?: string
): boolean {
	const entry = pending.get(id);
	if (!entry || entry.kind !== kind || entry.userId !== userId) return false;
	entry.settle(value, note);
	return true;
}

/** Test seam: prompts still waiting, for assertions about cleanup. */
export function openPromptCount(kind?: PromptKind): number {
	if (!kind) return pending.size;
	let n = 0;
	for (const p of pending.values()) if (p.kind === kind) n++;
	return n;
}
