import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, runMigrations } from '$lib/server/db';
import { notifications, pushSubscriptions, settings } from '$lib/server/db/schema';
import {
	listNotifications,
	markAllRead,
	markRead,
	notify,
	resolveEntity,
	resolveOpened,
	subscribeNotifications,
	subscribeRead,
	unreadCount
} from './notifications';

const ALICE = 'user-alice';
const BOB = 'user-bob';

beforeAll(() => {
	runMigrations();
});

beforeEach(() => {
	db.delete(notifications).run();
	db.delete(pushSubscriptions).run();
	db.delete(settings).run();
});

const raise = (userId: string, title: string, extra: Record<string, unknown> = {}) =>
	notify({ userId, kind: 'card-assigned', title, ...extra });

describe('addressing', () => {
	it('keeps one person’s notifications out of the other’s', () => {
		raise(ALICE, 'For Alice');
		raise(BOB, 'For Bob');

		expect(listNotifications(ALICE).map((n) => n.title)).toEqual(['For Alice']);
		expect(listNotifications(BOB).map((n) => n.title)).toEqual(['For Bob']);
		expect(unreadCount(ALICE)).toBe(1);
	});

	it('lists newest first', () => {
		raise(ALICE, 'first');
		raise(ALICE, 'second');
		expect(listNotifications(ALICE).map((n) => n.title)).toEqual(['second', 'first']);
	});
});

describe('reading', () => {
	it('drops out of the unread count once read', () => {
		const n = raise(ALICE, 'Bins');
		expect(unreadCount(ALICE)).toBe(1);

		expect(markRead(n.id, ALICE)).toBe(true);
		expect(unreadCount(ALICE)).toBe(0);
		// Still listed — reading is not deleting.
		expect(listNotifications(ALICE)).toHaveLength(1);
	});

	it('refuses to let one person read another’s', () => {
		const n = raise(ALICE, 'Bins');
		expect(markRead(n.id, BOB)).toBe(false);
		expect(unreadCount(ALICE)).toBe(1);
	});

	it('reports a second read as false rather than erroring', () => {
		const n = raise(ALICE, 'Bins');
		expect(markRead(n.id, ALICE)).toBe(true);
		expect(markRead(n.id, ALICE)).toBe(false);
	});

	it('clears the lot', () => {
		raise(ALICE, 'one');
		raise(ALICE, 'two');
		raise(BOB, 'not mine');

		expect(markAllRead(ALICE)).toBe(2);
		expect(unreadCount(ALICE)).toBe(0);
		expect(unreadCount(BOB)).toBe(1);
	});
});

describe('resolving by subject', () => {
	it('clears what was raised about a thing once it is handled elsewhere', () => {
		// A question answered in the drawer must not leave the bell still asking.
		notify({ userId: ALICE, kind: 'question', title: 'Which account?', entityId: 'q1' });
		notify({ userId: ALICE, kind: 'card-assigned', title: 'Unrelated', entityId: 'c1' });

		expect(resolveEntity('q1')).toBe(1);
		expect(unreadCount(ALICE)).toBe(1);
		expect(listNotifications(ALICE, { unreadOnly: true }).map((n) => n.title)).toEqual([
			'Unrelated'
		]);
	});

	it('does not touch an already-read row', () => {
		const n = notify({ userId: ALICE, kind: 'question', title: 'Q', entityId: 'q1' });
		markRead(n.id, ALICE);
		expect(resolveEntity('q1')).toBe(0);
	});

	it('can be scoped to one user when two share a subject', () => {
		notify({ userId: ALICE, kind: 'board-shared', title: 'Board', entityId: 'b1' });
		notify({ userId: BOB, kind: 'board-shared', title: 'Board', entityId: 'b1' });

		expect(resolveEntity('b1', ALICE)).toBe(1);
		expect(unreadCount(ALICE)).toBe(0);
		expect(unreadCount(BOB)).toBe(1);
	});
});

describe('clearing on engagement', () => {
	const CHAT = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
	const JOB = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

	it('clears an alert when you open what it pointed at', () => {
		// A failed turn is filed under its job id but points at the chat, so
		// matching only on entityId would never clear it.
		notify({
			userId: ALICE,
			kind: 'turn-failed',
			title: 'A run failed',
			link: `/chat?chat=${CHAT}`,
			entityId: JOB
		});
		expect(resolveOpened(ALICE, CHAT)).toBe(1);
		expect(unreadCount(ALICE)).toBe(0);
	});

	it('matches on the subject as well as the link', () => {
		notify({ userId: ALICE, kind: 'board-shared', title: 'Board', link: '/boards', entityId: 'b1' });
		expect(resolveOpened(ALICE, 'b1')).toBe(1);
	});

	it('leaves a pending question alone, because the agent is still waiting', () => {
		// Glancing at the chat does not answer it. Dropping the badge here would
		// retire the one alert that means work is blocked.
		notify({
			userId: ALICE,
			kind: 'question',
			title: 'Which account?',
			link: `/chat?chat=${CHAT}`,
			entityId: 'q1',
			urgent: true
		});
		expect(resolveOpened(ALICE, CHAT)).toBe(0);
		expect(unreadCount(ALICE)).toBe(1);
		// Answering is what clears it, exactly as before.
		expect(resolveEntity('q1', ALICE)).toBe(1);
	});

	it('never reaches another user opening the same thing', () => {
		notify({ userId: BOB, kind: 'card-done', title: 'Done', link: `/chat?chat=${CHAT}` });
		expect(resolveOpened(ALICE, CHAT)).toBe(0);
		expect(unreadCount(BOB)).toBe(1);
	});

	it('leaves alerts about other places untouched', () => {
		notify({ userId: ALICE, kind: 'card-assigned', title: 'A card', link: '/boards?card=other' });
		expect(resolveOpened(ALICE, CHAT)).toBe(0);
		expect(unreadCount(ALICE)).toBe(1);
	});

	it('is a no-op when nothing was opened', () => {
		raise(ALICE, 'Something');
		expect(resolveOpened(ALICE)).toBe(0);
		expect(resolveOpened(ALICE, null, undefined)).toBe(0);
		expect(unreadCount(ALICE)).toBe(1);
	});

	it('tells other tabs, so a second window drops its badge', () => {
		const seen: string[][] = [];
		const off = subscribeRead(ALICE, (ids) => seen.push(ids));
		const n = notify({ userId: ALICE, kind: 'card-done', title: 'Done', entityId: 'c9' });
		resolveOpened(ALICE, 'c9');
		off();
		expect(seen).toEqual([[n.id]]);
	});
});

describe('the live feed', () => {
	it('delivers to the right person only', () => {
		const forAlice: string[] = [];
		const forBob: string[] = [];
		const offA = subscribeNotifications(ALICE, (n) => forAlice.push(n.title));
		const offB = subscribeNotifications(BOB, (n) => forBob.push(n.title));

		raise(ALICE, 'hers');
		offA();
		offB();

		expect(forAlice).toEqual(['hers']);
		expect(forBob).toEqual([]);
	});

	it('tells other tabs when something is read', () => {
		const seen: string[][] = [];
		const off = subscribeRead(ALICE, (ids) => seen.push(ids));
		const n = raise(ALICE, 'Bins');
		markRead(n.id, ALICE);
		off();

		expect(seen).toEqual([[n.id]]);
	});
});

describe('not breaking the caller', () => {
	it('still records the notification when push blows up', async () => {
		// Push talks to an external service; a turn must not fail because a phone
		// is unreachable.
		const push = await import('$lib/server/push');
		const spy = vi.spyOn(push, 'sendPush').mockRejectedValue(new Error('push service down'));

		expect(() => notify({ userId: ALICE, kind: 'question', title: 'Q', urgent: true })).not.toThrow();
		expect(unreadCount(ALICE)).toBe(1);
		spy.mockRestore();
	});
});
