import { beforeAll, describe, expect, it } from 'vitest';
import { db, runMigrations } from '$lib/server/db';
import { jobs } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import {
	cancelJob,
	completeJob,
	createJob,
	failJob,
	findRunningJobForChat,
	isCancellation,
	jobAgeMinutes,
	JobCancelledError,
	RUNNING_JOB_MAX_MS,
	subscribeJob,
	type JobChunk
} from './jobs';

beforeAll(() => {
	runMigrations();
});

const newJob = (persist = false) =>
	createJob({ chatId: 'c1', userId: 'u1', task: 'chat', persist });

describe('isCancellation', () => {
	it('recognises a stop, however it surfaces', () => {
		expect(isCancellation(new JobCancelledError())).toBe(true);
		// fetch rejects with a DOMException named AbortError, not our class.
		expect(isCancellation(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toBe(true);
		// An aborted signal is enough even when the error is something else, since
		// a torn-down connection can surface as almost anything.
		const ac = new AbortController();
		ac.abort();
		expect(isCancellation(new Error('socket hang up'), ac.signal)).toBe(true);
	});

	it('does not swallow genuine failures', () => {
		expect(isCancellation(new Error('502 Bad Gateway'))).toBe(false);
		expect(isCancellation(new Error('socket hang up'), new AbortController().signal)).toBe(false);
	});
});

describe('cancelJob', () => {
	it('aborts the signal so an in-flight model call drops', () => {
		const job = newJob();
		expect(job.controller.signal.aborted).toBe(false);
		expect(cancelJob(job)).toBe(true);
		expect(job.controller.signal.aborted).toBe(true);
	});

	it('leaves the job running so the loop can save its partial reply', () => {
		// The point of not finishing the job here: executeWithModel still has to
		// reach onDone with whatever text it accumulated.
		const job = newJob();
		cancelJob(job);
		expect(job.status).toBe('running');
	});

	it('is idempotent and ignores finished jobs', () => {
		const job = newJob();
		expect(cancelJob(job)).toBe(true);
		expect(cancelJob(job)).toBe(false);

		const done = newJob();
		completeJob(done);
		expect(cancelJob(done)).toBe(false);
	});

	it('tells subscribers it is stopping', () => {
		const job = newJob();
		const seen: JobChunk[] = [];
		subscribeJob(job, (c) => seen.push(c));
		cancelJob(job);
		expect(seen.at(-1)).toEqual({ type: 'notice', text: 'Stopping…' });
	});
});

describe('completeJob after a cancel', () => {
	it('records cancelled rather than done, and flags the final chunk', () => {
		const job = newJob();
		const seen: JobChunk[] = [];
		subscribeJob(job, (c) => seen.push(c));
		cancelJob(job);
		completeJob(job, 'msg-1');

		expect(job.status).toBe('cancelled');
		expect(seen.at(-1)).toEqual({ type: 'done', messageId: 'msg-1', stopped: true });
	});

	it('is still a normal done when nobody stopped it', () => {
		const job = newJob();
		completeJob(job, 'msg-2');
		expect(job.status).toBe('done');
		expect(job.chunks.at(-1)).toEqual({ type: 'done', messageId: 'msg-2' });
	});

	it('persists the cancelled state without calling it an error', () => {
		const job = newJob(true);
		cancelJob(job);
		completeJob(job, 'msg-3');
		const row = db.select().from(jobs).where(eq(jobs.id, job.id)).get()!;
		expect(row.status).toBe('cancelled');
		expect(row.error).toBe('Stopped by user');
		expect(row.finishedAt).toBeTruthy();
	});

	it('keeps failJob distinct, so real errors still read as errors', () => {
		const job = newJob(true);
		failJob(job, 'provider exploded');
		const row = db.select().from(jobs).where(eq(jobs.id, job.id)).get()!;
		expect(row.status).toBe('error');
		expect(job.status).toBe('error');
	});
});

describe('findRunningJobForChat', () => {
	/** A distinct chat per test: `live` is module state shared across this file. */
	const jobFor = (chatId: string, task = 'chat') =>
		createJob({ chatId, userId: 'u1', task, persist: false });

	it('reports the run that is holding a chat', () => {
		const job = jobFor('watchdog-a');
		expect(findRunningJobForChat('watchdog-a')?.id).toBe(job.id);
	});

	it('ignores a job that has already finished', () => {
		const job = jobFor('watchdog-b');
		completeJob(job);
		expect(findRunningJobForChat('watchdog-b')).toBeNull();
	});

	it('fails a job that has been running too long instead of reporting it', () => {
		// A job only leaves `running` via completeJob/failJob, so one that neither
		// finishes nor throws — an ask_user nobody answered — used to refuse every
		// later message in that chat until the process restarted.
		const job = jobFor('watchdog-c', 'deep-research');
		const later = Date.now() + RUNNING_JOB_MAX_MS + 1;
		expect(findRunningJobForChat('watchdog-c', later)).toBeNull();
		expect(job.status).toBe('error');
		// And it says why, so the chat is not just silently unblocked.
		expect(job.chunks.at(-1)).toMatchObject({ type: 'error' });
	});

	it('leaves a long-but-not-abandoned run alone', () => {
		const job = jobFor('watchdog-d');
		const later = Date.now() + RUNNING_JOB_MAX_MS - 1000;
		expect(findRunningJobForChat('watchdog-d', later)?.id).toBe(job.id);
		expect(job.status).toBe('running');
	});

	it('reports the age in whole minutes for the message the user sees', () => {
		const job = jobFor('watchdog-e');
		expect(jobAgeMinutes(job, job.createdAt)).toBe(0);
		expect(jobAgeMinutes(job, job.createdAt + 14 * 60_000)).toBe(14);
	});
});
