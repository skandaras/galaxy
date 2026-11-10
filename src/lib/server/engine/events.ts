import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { db } from '$lib/server/db';
import { events } from '$lib/server/db/schema';

export interface GalaxyEvent {
	id: string;
	ts: number;
	userId?: string;
	chatId?: string;
	task?: string;
	type:
		| 'model.call'
		| 'tool.call'
		| 'job'
		| 'failover'
		| 'compaction'
		| 'admin'
		| 'budget'
		// A crash in someone's browser. The Observatory is the only place the
		// phone can be read from, and an events row needs no migration.
		| 'client';
	name: string;
	status: 'ok' | 'error' | 'running';
	durationMs?: number;
	detail?: Record<string, unknown>;
	/**
	 * Set on an event that was not stored, which is one from a hidden chat.
	 * The live feed shows these to the person whose chat it is and to nobody
	 * else: an admin's feed carries everyone's events, and it carried these
	 * too, tool arguments and search queries included.
	 */
	unrecorded?: true;
}

const bus = new EventEmitter();
bus.setMaxListeners(100);

/**
 * Emit an Observatory event: fan out live to subscribers and persist it —
 * unless persist is false (hidden chats are watchable live, never recorded).
 */
export function emitEvent(
	e: Omit<GalaxyEvent, 'id' | 'ts'>,
	opts: { persist?: boolean } = {}
): GalaxyEvent {
	const full: GalaxyEvent = {
		id: randomUUID(),
		ts: Date.now(),
		...e,
		...(opts.persist === false ? { unrecorded: true as const } : {})
	};
	if (opts.persist !== false) {
		db.insert(events)
			.values({
				id: full.id,
				ts: new Date(full.ts),
				userId: full.userId ?? null,
				chatId: full.chatId ?? null,
				task: full.task ?? null,
				type: full.type,
				name: full.name,
				status: full.status,
				durationMs: full.durationMs ?? null,
				detail: full.detail ?? null
			})
			.run();
	}
	bus.emit('event', full);
	return full;
}

/** Whether `viewer` may be shown this event on the live feed. */
export function eventVisibleTo(e: GalaxyEvent, viewer: { id: string; isAdmin: boolean }): boolean {
	if (e.userId === viewer.id) return true;
	return viewer.isAdmin && !e.unrecorded;
}

export function subscribeEvents(cb: (e: GalaxyEvent) => void): () => void {
	bus.on('event', cb);
	return () => bus.off('event', cb);
}
