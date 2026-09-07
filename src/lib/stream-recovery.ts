/**
 * What to do when a run's SSE connection drops.
 *
 * The chat page and the code page each had their own copy of this — thirty-seven
 * lines apiece, differing in eight places, all of them names. Both copies had the
 * same three bugs, which is the argument for it being here rather than fixed
 * twice: the pages have no test harness (no DOM in vitest, by design — see
 * AGENTS.md), so the protocol was untestable while it lived inside them.
 *
 * This module holds the decisions only. Creating the EventSource, holding the
 * messages and drawing the banner stay in the pages, where they belong.
 */

/** Reattaches allowed before a run is given up on. */
export const MAX_RECOVERIES = 6;

/** Backoff between reattaches, capped so a long run keeps trying. */
export function recoveryDelayMs(attempt: number): number {
	return Math.min(15_000, 500 * 2 ** attempt);
}

/**
 * How much of this attach was replay, and how much was new.
 *
 * The reconnect budget used to reset on *any* chunk arriving, on the reasoning
 * that a chunk is proof the stream works. It is not: subscribing to a job
 * replays its whole buffer synchronously before a single live chunk, so every
 * reattach reset the budget and the backoff one tick after connecting.
 * MAX_RECOVERIES was unreachable and a flapping connection reconnected forever at
 * 500ms — the two guards that exist for exactly that case, both dead.
 *
 * So progress means chunks *past* the replayed prefix: more than the previous
 * attach ever saw. A buffer that shrinks (chunks are coalesced) simply never
 * counts as progress, which errs towards giving up rather than looping, and that
 * is the right way to be wrong here.
 */
export interface ReplayCounter {
	/** Chunks the previous attach delivered — this attach replays them first. */
	replayed: number;
	/** Chunks this attach has delivered so far. */
	received: number;
}

export function newReplayCounter(): ReplayCounter {
	return { replayed: 0, received: 0 };
}

/** Call when attaching: what the last attach saw is what this one will replay. */
export function beginAttach(counter: ReplayCounter): void {
	counter.replayed = counter.received;
	counter.received = 0;
}

/** Call per chunk. True once this attach has gone past the replay. */
export function noteChunk(counter: ReplayCounter): boolean {
	counter.received++;
	return counter.received > counter.replayed;
}

export type RecoveryAction =
	/** Wait, then reconcile again — the server did not answer. */
	| { kind: 'refetch'; waitMs: number; banner: string }
	/** Wait, then reattach to the run that is still going. */
	| { kind: 'reattach'; jobId: string; waitMs: number; banner: string }
	/** Out of reattaches, and the run is still going without us. */
	| { kind: 'exhausted'; banner: string }
	/** The run died before its reply was saved; show what did arrive. */
	| { kind: 'incomplete'; banner: string }
	/** It ended with nothing, and there is no partial to fall back on. */
	| { kind: 'no-reply'; banner: string }
	/** The server has the finished reply. Nothing to say. */
	| { kind: 'settled' };

export interface RecoveryInput {
	/** Reattaches already spent since the stream last made progress. */
	attempt: number;
	/** Whether the reconcile fetch came back at all. */
	fetchOk: boolean;
	/** The run the server says is still going, if any. */
	runningJobId: string | null;
	/** Whether the browser has streamed text it has not committed. */
	hasPartial: boolean;
	/** Whether the server's copy already ends in an assistant reply. */
	answered: boolean;
	/** What this page calls a conversation, for the banners. */
	noun: 'chat' | 'session';
}

/**
 * Decide the next move after an interrupted stream.
 *
 * A failed reconcile used to end recovery permanently — one transient 502 on the
 * way to asking "did it finish?" and the run was abandoned, even though its
 * chunks stay replayable for ten minutes afterwards. It retries on the same
 * budget as everything else now.
 */
export function planRecovery(input: RecoveryInput): RecoveryAction {
	const { attempt, noun } = input;
	const exhausted = attempt >= MAX_RECOVERIES;

	if (!input.fetchOk) {
		if (exhausted) {
			return {
				kind: 'exhausted',
				banner: `Lost the connection to this run — reopen the ${noun} to see how it ended.`
			};
		}
		return {
			kind: 'refetch',
			waitMs: recoveryDelayMs(attempt),
			banner: 'Reconnecting to this run…'
		};
	}

	if (input.runningJobId) {
		if (exhausted) {
			return {
				kind: 'exhausted',
				banner: `Kept losing the connection to this run — reopen the ${noun} to catch up.`
			};
		}
		return {
			kind: 'reattach',
			jobId: input.runningJobId,
			waitMs: recoveryDelayMs(attempt),
			banner: 'Reconnecting to this run…'
		};
	}

	if (input.answered) return { kind: 'settled' };
	if (input.hasPartial) {
		return {
			kind: 'incomplete',
			banner: `The connection dropped mid-${noun === 'chat' ? 'reply' : 'run'} — this ${noun === 'chat' ? 'answer' : 'reply'} is incomplete.`
		};
	}
	return {
		kind: 'no-reply',
		banner: 'That run ended without a reply. Check the Observatory for the reason.'
	};
}

/**
 * Whether a cancel request actually cancelled anything.
 *
 * Both pages fired the POST and discarded the answer, so a 404 (which is also
 * what another user's job returns) or a 500 was indistinguishable from success —
 * and `stopping` is only ever cleared by a chunk that, in that case, is never
 * coming. The stop button stayed disabled showing an ellipsis, with an early
 * return blocking any retry, for a run still merrily going.
 */
export function cancelFailureBanner(res: { ok: boolean; status: number } | null): string | null {
	if (res?.ok) return null;
	if (!res) return 'Could not reach the server to stop this run — try again.';
	if (res.status === 404) return 'That run had already finished or is no longer yours.';
	return `Could not stop this run (${res.status}) — try again.`;
}
