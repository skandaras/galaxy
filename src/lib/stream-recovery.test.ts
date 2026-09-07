import { describe, expect, it } from 'vitest';
import {
	MAX_RECOVERIES,
	beginAttach,
	cancelFailureBanner,
	newReplayCounter,
	noteChunk,
	planRecovery,
	recoveryDelayMs,
	type RecoveryInput
} from './stream-recovery';

const base: RecoveryInput = {
	attempt: 0,
	fetchOk: true,
	runningJobId: null,
	hasPartial: false,
	answered: false,
	noun: 'chat'
};

describe('replay is not progress', () => {
	it('does not credit a reattach for the chunks it replays', () => {
		const c = newReplayCounter();
		// First attach: five live chunks.
		beginAttach(c);
		for (let i = 0; i < 5; i++) noteChunk(c);

		// It drops and reattaches. The server replays those same five
		// synchronously, before anything new — this is what used to reset the
		// budget and the backoff one tick after connecting.
		beginAttach(c);
		const credited = [0, 1, 2, 3, 4].map(() => noteChunk(c));
		expect(credited).toEqual([false, false, false, false, false]);
	});

	it('credits the first chunk past the replay', () => {
		const c = newReplayCounter();
		beginAttach(c);
		noteChunk(c);
		noteChunk(c);

		beginAttach(c);
		expect(noteChunk(c)).toBe(false);
		expect(noteChunk(c)).toBe(false);
		// The sixth chunk overall is the run actually getting somewhere.
		expect(noteChunk(c)).toBe(true);
	});

	it('stays conservative when the buffer shrinks', () => {
		// Chunks are coalesced server-side, so a later attach can replay fewer
		// than the last one saw. Never counting that as progress errs towards
		// giving up rather than reconnecting forever.
		const c = newReplayCounter();
		beginAttach(c);
		for (let i = 0; i < 10; i++) noteChunk(c);
		beginAttach(c);
		expect([1, 2, 3].map(() => noteChunk(c))).toEqual([false, false, false]);
	});
});

describe('planning the next move', () => {
	it('reattaches to a run the server says is still going', () => {
		const plan = planRecovery({ ...base, runningJobId: 'j1' });
		expect(plan).toMatchObject({ kind: 'reattach', jobId: 'j1' });
	});

	it('retries a reconcile that failed instead of giving up on the run', () => {
		// One transient 502 used to end recovery permanently, even though the
		// job's chunks stay replayable for ten minutes.
		const plan = planRecovery({ ...base, fetchOk: false });
		expect(plan.kind).toBe('refetch');
	});

	it('backs off further with each attempt', () => {
		const first = planRecovery({ ...base, runningJobId: 'j1', attempt: 0 });
		const later = planRecovery({ ...base, runningJobId: 'j1', attempt: 4 });
		expect(first.kind === 'reattach' && later.kind === 'reattach').toBe(true);
		if (first.kind === 'reattach' && later.kind === 'reattach') {
			expect(later.waitMs).toBeGreaterThan(first.waitMs);
		}
	});

	it('caps the backoff so a long run keeps trying', () => {
		expect(recoveryDelayMs(50)).toBe(15_000);
	});

	it('gives up once the budget is spent, whichever way it failed', () => {
		for (const input of [
			{ ...base, runningJobId: 'j1', attempt: MAX_RECOVERIES },
			{ ...base, fetchOk: false, attempt: MAX_RECOVERIES }
		]) {
			expect(planRecovery(input).kind).toBe('exhausted');
		}
	});

	it('says nothing when the server already has the finished reply', () => {
		expect(planRecovery({ ...base, answered: true }).kind).toBe('settled');
	});

	it('keeps a partial reply the server never saved, and marks it unfinished', () => {
		const plan = planRecovery({ ...base, hasPartial: true });
		expect(plan.kind).toBe('incomplete');
		expect(plan.kind === 'incomplete' && plan.banner).toContain('incomplete');
	});

	it('reports an empty run rather than inventing an answer', () => {
		expect(planRecovery(base).kind).toBe('no-reply');
	});

	it('speaks the language of the page it is on', () => {
		const chat = planRecovery({ ...base, runningJobId: 'j', attempt: MAX_RECOVERIES });
		const code = planRecovery({
			...base,
			noun: 'session',
			runningJobId: 'j',
			attempt: MAX_RECOVERIES
		});
		expect(chat.banner).toContain('chat');
		expect(code.banner).toContain('session');
	});
});

describe('cancel responses', () => {
	it('says nothing when the run really was cancelled', () => {
		expect(cancelFailureBanner({ ok: true, status: 200 })).toBeNull();
	});

	it('names a failure rather than leaving the button spinning', () => {
		// 404 is also what another user's job returns, which is why it gets its
		// own wording rather than a bare status code.
		expect(cancelFailureBanner({ ok: false, status: 404 })).toContain('already finished');
		expect(cancelFailureBanner({ ok: false, status: 500 })).toContain('500');
		expect(cancelFailureBanner(null)).toContain('reach the server');
	});
});
