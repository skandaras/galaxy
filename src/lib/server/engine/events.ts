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
	type: 'model.call' | 'tool.call' | 'job' | 'failover' | 'compaction' | 'admin' | 'budget';
	name: string;
	status: 'ok' | 'error' | 'running';
	durationMs?: number;
	detail?: Record<string, unknown>;
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
	const full: GalaxyEvent = { id: randomUUID(), ts: Date.now(), ...e };
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

export function subscribeEvents(cb: (e: GalaxyEvent) => void): () => void {
	bus.on('event', cb);
	return () => bus.off('event', cb);
}
