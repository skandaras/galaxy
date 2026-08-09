import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { notifications, type NotificationKind } from '$lib/server/db/schema';
import { sendPush } from '$lib/server/push';

export type Notification = typeof notifications.$inferSelect;

const bus = new EventEmitter();
bus.setMaxListeners(100);

/** Keeps one person's list from growing without bound. */
const MAX_PER_USER = 200;

export interface NotifyOptions {
	userId: string;
	kind: NotificationKind;
	title: string;
	body?: string;
	/** In-app destination, e.g. /chat?chat=… — also the push click target. */
	link?: string;
	/** Subject of the notification, so it can be cleared when that is handled. */
	entityId?: string;
	/**
	 * Worth waking a phone for. Reserved for things that hold work up — today
	 * only an agent parked on a question.
	 */
	urgent?: boolean;
}

/**
 * Record something one person needs to look at, tell any open tab, and — for
 * urgent things — push it to their devices.
 *
 * Never throws: a notification failing must not take down the turn that raised
 * it. Push in particular talks to an external service and is fired and
 * forgotten.
 */
export function notify(opts: NotifyOptions): Notification {
	const row: Notification = {
		id: randomUUID(),
		userId: opts.userId,
		kind: opts.kind,
		title: opts.title,
		body: opts.body ?? '',
		link: opts.link ?? '',
		entityId: opts.entityId ?? null,
		urgent: opts.urgent ?? false,
		createdAt: new Date(),
		readAt: null
	};
	db.insert(notifications).values(row).run();
	prune(opts.userId);
	bus.emit('notification', row);

	// Push is best-effort and out of band: a dead endpoint or an unreachable
	// push service must not surface as a failed tool call.
	void sendPush(row).catch(() => {
		/* sendPush reports its own failures via events */
	});
	return row;
}

/** Live feed for one user's open tabs. Returns an unsubscribe fn. */
export function subscribeNotifications(
	userId: string,
	cb: (n: Notification) => void
): () => void {
	const handler = (n: Notification) => {
		if (n.userId === userId) cb(n);
	};
	bus.on('notification', handler);
	return () => bus.off('notification', handler);
}

/** Emitted when something is read elsewhere, so other tabs drop the badge. */
export function subscribeRead(userId: string, cb: (ids: string[]) => void): () => void {
	const handler = (e: { userId: string; ids: string[] }) => {
		if (e.userId === userId) cb(e.ids);
	};
	bus.on('read', handler);
	return () => bus.off('read', handler);
}

export function listNotifications(
	userId: string,
	opts: { unreadOnly?: boolean; limit?: number } = {}
): Notification[] {
	const where = opts.unreadOnly
		? and(eq(notifications.userId, userId), isNull(notifications.readAt))!
		: eq(notifications.userId, userId);
	return db
		.select()
		.from(notifications)
		.where(where)
		// Insertion order, not uuid order: several notifications can land in the
		// same millisecond (a hand-off finishing and the question it asked), and a
		// tie broken on a random id reshuffles the list on every refresh.
		.orderBy(desc(notifications.createdAt), desc(sql`rowid`))
		.limit(Math.min(opts.limit ?? 50, 200))
		.all();
}

export function unreadCount(userId: string): number {
	const row = db
		.select({ n: sql<number>`count(*)` })
		.from(notifications)
		.where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
		.get();
	return row?.n ?? 0;
}

export function markRead(id: string, userId: string): boolean {
	const res = db
		.update(notifications)
		.set({ readAt: new Date() })
		.where(and(eq(notifications.id, id), eq(notifications.userId, userId), isNull(notifications.readAt)))
		.run();
	if (res.changes > 0) bus.emit('read', { userId, ids: [id] });
	return res.changes > 0;
}

export function markAllRead(userId: string): number {
	const ids = db
		.select({ id: notifications.id })
		.from(notifications)
		.where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
		.all()
		.map((r) => r.id);
	if (!ids.length) return 0;
	db.update(notifications)
		.set({ readAt: new Date() })
		.where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
		.run();
	bus.emit('read', { userId, ids });
	return ids.length;
}

/**
 * Clear whatever was raised about `entityId`, because it has now been dealt
 * with somewhere else — a question answered in the drawer, a card opened.
 *
 * Without this the badge keeps asking for attention that has already been
 * given, which is the fastest way to teach someone to ignore it.
 */
export function resolveEntity(entityId: string, userId?: string): number {
	const rows = db
		.select({ id: notifications.id, userId: notifications.userId })
		.from(notifications)
		.where(and(eq(notifications.entityId, entityId), isNull(notifications.readAt)))
		.all()
		.filter((r) => !userId || r.userId === userId);
	return clear(rows);
}

/**
 * Kinds that arriving does not settle, because something is still owed.
 *
 * A question is the whole of this list: an agent parked waiting on an answer
 * is still parked after you have glanced at the chat, and dropping the badge
 * there would quietly retire the one alert that means work is blocked. Those
 * clear when the question is answered — see resolveEntity in ask-user.ts.
 */
const NEEDS_ACTION: NotificationKind[] = ['question'];

/**
 * Clear whatever was pointing someone at a place they have now opened.
 *
 * Reading the bell was the only thing that cleared it, so opening the chat an
 * alert was about left the badge still asking for attention that had already
 * been given — and the fastest way to teach someone to ignore a bell is to
 * leave it ringing after they have answered it.
 *
 * Matches a notification's `entityId` *or* its `link`, because the link is the
 * notification's own statement of where it was sending you: a failed turn is
 * filed under its job id but points at the chat. Ids here are uuids, so a
 * substring match on the link cannot collide.
 */
export function resolveOpened(userId: string, ...ids: (string | null | undefined)[]): number {
	const wanted = ids.filter((id): id is string => Boolean(id));
	if (!wanted.length) return 0;
	const rows = db
		.select({
			id: notifications.id,
			userId: notifications.userId,
			kind: notifications.kind,
			entityId: notifications.entityId,
			link: notifications.link
		})
		.from(notifications)
		.where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
		.all()
		.filter((r) => !NEEDS_ACTION.includes(r.kind))
		.filter((r) => wanted.some((id) => r.entityId === id || (r.link && r.link.includes(id))));
	return clear(rows);
}

/** Mark a set of rows read and tell every open tab that owns one. */
function clear(rows: { id: string; userId: string }[]): number {
	if (!rows.length) return 0;
	for (const r of rows) {
		db.update(notifications).set({ readAt: new Date() }).where(eq(notifications.id, r.id)).run();
	}
	for (const owner of new Set(rows.map((r) => r.userId))) {
		bus.emit('read', { userId: owner, ids: rows.filter((r) => r.userId === owner).map((r) => r.id) });
	}
	return rows.length;
}

/** Keep only the newest MAX_PER_USER rows for a user. */
function prune(userId: string): void {
	const all = db
		.select({ id: notifications.id })
		.from(notifications)
		.where(eq(notifications.userId, userId))
		.orderBy(desc(notifications.createdAt), desc(sql`rowid`))
		.all();
	for (const row of all.slice(MAX_PER_USER)) {
		db.delete(notifications).where(eq(notifications.id, row.id)).run();
	}
}
