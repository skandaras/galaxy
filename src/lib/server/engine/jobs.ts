import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { jobs } from '$lib/server/db/schema';

export type JobChunk =
	| { type: 'meta'; model: string }
	| { type: 'delta'; text: string }
	| { type: 'tool'; name: string; status: 'running' | 'ok' | 'error'; detail?: string }
	| { type: 'stage'; name: string; detail?: string }
	| { type: 'notice'; text: string }
	| { type: 'done'; messageId?: string; stopped?: boolean }
	| { type: 'error'; message: string };

export interface LiveJob {
	id: string;
	chatId: string;
	userId: string;
	task: string;
	// The status column is plain TEXT with no CHECK constraint, so adding
	// 'cancelled' needs no migration.
	status: 'running' | 'done' | 'error' | 'cancelled';
	/** Aborted by cancelJob; threaded into model calls and checked between steps. */
	controller: AbortController;
	/** Full chunk history — replayed to late/reconnecting subscribers. */
	chunks: JobChunk[];
	subscribers: Set<(chunk: JobChunk) => void>;
	persist: boolean;
	createdAt: number;
}

// Jobs run server-side and outlive browser disconnects. Live state is
// in-memory (single-node); the jobs table keeps a persistent history row.
const live = new Map<string, LiveJob>();
const FINISHED_JOB_TTL_MS = 10 * 60 * 1000;

export function createJob(opts: {
	chatId: string;
	userId: string;
	task: string;
	persist: boolean;
}): LiveJob {
	const job: LiveJob = {
		id: randomUUID(),
		chatId: opts.chatId,
		userId: opts.userId,
		task: opts.task,
		status: 'running',
		controller: new AbortController(),
		chunks: [],
		subscribers: new Set(),
		persist: opts.persist,
		createdAt: Date.now()
	};
	live.set(job.id, job);
	if (job.persist) {
		db.insert(jobs)
			.values({
				id: job.id,
				chatId: job.chatId,
				userId: job.userId,
				task: job.task,
				status: 'running',
				createdAt: new Date()
			})
			.run();
	}
	return job;
}

export function pushChunk(job: LiveJob, chunk: JobChunk): void {
	job.chunks.push(chunk);
	for (const sub of job.subscribers) sub(chunk);
}

export function completeJob(job: LiveJob, messageId?: string): void {
	// A run the user stopped still finishes normally — the partial reply is kept
	// — but it is recorded as cancelled rather than done.
	const stopped = job.controller.signal.aborted;
	job.status = stopped ? 'cancelled' : 'done';
	pushChunk(job, { type: 'done', messageId, ...(stopped ? { stopped: true } : {}) });
	persistFinal(job, stopped ? 'Stopped by user' : null);
}

/**
 * Ask a running job to stop. Aborts the model call in flight and leaves the
 * loop to wind down at its next check, which is what saves the partial reply —
 * so this does not mark the job finished itself.
 */
export function cancelJob(job: LiveJob): boolean {
	if (job.status !== 'running' || job.controller.signal.aborted) return false;
	job.controller.abort(new JobCancelledError());
	pushChunk(job, { type: 'notice', text: 'Stopping…' });
	return true;
}

/** Abort reason, so a cancel can be told apart from a network failure. */
export class JobCancelledError extends Error {
	constructor() {
		super('Stopped by user');
		this.name = 'JobCancelledError';
	}
}

/** True when this error is a cancellation rather than a genuine failure. */
export function isCancellation(err: unknown, signal?: AbortSignal): boolean {
	if (signal?.aborted) return true;
	if (err instanceof JobCancelledError) return true;
	const name = (err as { name?: unknown })?.name;
	return name === 'JobCancelledError' || name === 'AbortError';
}

export function failJob(job: LiveJob, error: string): void {
	job.status = 'error';
	pushChunk(job, { type: 'error', message: error });
	persistFinal(job, error);
}

function persistFinal(job: LiveJob, error: string | null): void {
	if (job.persist) {
		db.update(jobs)
			.set({ status: job.status, error, finishedAt: new Date() })
			.where(eq(jobs.id, job.id))
			.run();
	}
	// Keep the buffer around briefly so a reconnecting client can still replay.
	setTimeout(() => live.delete(job.id), FINISHED_JOB_TTL_MS).unref?.();
}

export function getLiveJob(id: string): LiveJob | null {
	return live.get(id) ?? null;
}

export function findRunningJobForChat(chatId: string): LiveJob | null {
	for (const job of live.values()) {
		if (job.chatId === chatId && job.status === 'running') return job;
	}
	return null;
}

/** Replay history, then follow live chunks. Returns an unsubscribe fn. */
export function subscribeJob(job: LiveJob, cb: (chunk: JobChunk) => void): () => void {
	for (const chunk of job.chunks) cb(chunk);
	job.subscribers.add(cb);
	return () => job.subscribers.delete(cb);
}
