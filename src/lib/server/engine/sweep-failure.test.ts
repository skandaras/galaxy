import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, runMigrations } from '$lib/server/db';
import { events } from '$lib/server/db/schema';
import { runSweep } from './scheduler';

/**
 * The failures that used to leave nothing behind at all.
 *
 * Each sweep swallowed with an empty catch on the grounds that the agent
 * "reports its own failures via events" — true of what happens inside the
 * agent's own try block, and not of the DB reads before it. A throw there
 * reached neither the Observatory nor stdout, because the empty catch had eaten
 * it before tick's own console.error could see it, and the agent went dark for
 * a whole interval with nothing to say why.
 */

beforeAll(() => runMigrations());
beforeEach(() => {
	db.delete(events).run();
});

const filed = () => db.select().from(events).where(eq(events.type, 'job')).all();

describe('runSweep', () => {
	it('says nothing when the agent finishes', async () => {
		await runSweep('memory', 'u1', async () => ({ ran: true }));
		expect(filed()).toHaveLength(0);
	});

	it('files a failure the agent never got far enough to report', async () => {
		await runSweep('memory', 'u1', async () => {
			throw new Error('settings row is malformed');
		});

		const [event] = filed();
		expect(event).toBeTruthy();
		expect(event.status).toBe('error');
		expect(event.task).toBe('memory');
		expect(event.userId).toBe('u1');
		expect(JSON.stringify(event.detail)).toContain('settings row is malformed');
	});

	it('does not let one user’s failure end the sweep', async () => {
		// The loop calling this runs users sequentially and must keep going, which
		// only holds while this resolves rather than rejects.
		await expect(
			runSweep('cortex-groom', 'u1', async () => {
				throw new Error('boom');
			})
		).resolves.toBeUndefined();
	});

	it('carries no user for a platform-wide agent', async () => {
		await runSweep('ux-audit', undefined, async () => {
			throw new Error('boom');
		});
		expect(filed()[0].userId).toBeNull();
	});
});
