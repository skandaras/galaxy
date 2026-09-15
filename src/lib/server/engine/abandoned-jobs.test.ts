import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, runMigrations } from '$lib/server/db';
import { events, jobs } from '$lib/server/db/schema';
import { closeAbandonedJobs } from './jobs';
import { previousRunNote } from './run-history';

/**
 * What a restart leaves behind.
 *
 * The live job map is in memory and the rows are not, so a process that goes
 * down mid-turn leaves its row at 'running' with nothing that will ever revisit
 * it: the staleness watchdog walks the live map, and the job is not in it. This
 * app updates itself, so that is an ordinary Tuesday rather than an exotic
 * failure.
 *
 * The second test is the one that matters. `previousRunNote` takes the newest
 * run that is *not* running, so a ghost row was skipped forever and the next
 * turn was never told the last attempt had died — it read as though nothing had
 * been asked at all.
 */

beforeAll(() => runMigrations());

const chatId = 'chat-abandoned';

const addJob = (status: 'running' | 'done', createdAt = new Date()) => {
	const id = randomUUID();
	db.insert(jobs)
		.values({ id, chatId, userId: 'u1', task: 'chat', status, createdAt })
		.run();
	return id;
};

beforeEach(() => {
	db.delete(jobs).run();
	db.delete(events).run();
});

describe('closeAbandonedJobs', () => {
	it('closes a run the previous process was still holding', () => {
		const id = addJob('running');
		expect(closeAbandonedJobs()).toBe(1);

		const row = db.select().from(jobs).where(eq(jobs.id, id)).get();
		// 'error' rather than 'cancelled': nobody chose this.
		expect(row?.status).toBe('error');
		expect(row?.error).toContain('restarted');
		expect(row?.finishedAt).toBeTruthy();
	});

	it('leaves runs that already finished alone', () => {
		addJob('done');
		expect(closeAbandonedJobs()).toBe(0);
	});

	it('files one event per abandoned run, so it is not silent', () => {
		addJob('running');
		addJob('running');
		closeAbandonedJobs();
		const filed = db.select().from(events).where(eq(events.name, 'job.abandoned')).all();
		expect(filed).toHaveLength(2);
		expect(filed[0].status).toBe('error');
	});

	it('lets the next turn find out the last one died', () => {
		addJob('running', new Date(Date.now() - 60_000));
		// Before: the ghost is filtered out as "still running" and the note is
		// empty, so the next turn re-runs the whole attempt with no idea why the
		// last one produced nothing.
		expect(previousRunNote(chatId)).toBe('');

		closeAbandonedJobs();
		expect(previousRunNote(chatId)).toContain('failed');
	});
});
