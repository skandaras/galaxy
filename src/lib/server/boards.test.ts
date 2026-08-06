import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, runMigrations } from '$lib/server/db';
import {
	boardLanes,
	boardMembers,
	boardStatuses,
	boards,
	cardLog,
	cards,
	users
} from '$lib/server/db/schema';
import {
	MAX_LANES,
	addLane,
	addMember,
	addStatus,
	boardRole,
	createBoard,
	createCard,
	deleteBoard,
	deleteLane,
	deleteStatus,
	getCard,
	listArchivedCards,
	listBoards,
	listCards,
	listLanes,
	listMembers,
	listStatuses,
	removeMember,
	updateBoard,
	updateCard
} from './boards';

const ALICE = 'user-alice';
const BOB = 'user-bob';

beforeAll(() => {
	runMigrations();
});

beforeEach(() => {
	for (const t of [cardLog, cards, boardLanes, boardStatuses, boardMembers, boards, users]) {
		db.delete(t).run();
	}
	for (const [id, username] of [
		[ALICE, 'alice'],
		[BOB, 'bob']
	]) {
		db.insert(users)
			.values({
				id,
				username,
				email: null,
				displayName: null,
				isAdmin: false,
				canCode: false,
				createdAt: new Date(),
				lastSeenAt: new Date()
			})
			.run();
	}
});

const board = (owner = ALICE) => createBoard({ ownerId: owner, name: 'Home' });
const firstLane = (boardId: string) => listLanes(boardId)[0];
const doneStatus = (boardId: string) => listStatuses(boardId).find((s) => s.isDone)!;

describe('creating a board', () => {
	it('gives the owner a member row, so membership is the only access rule', () => {
		const b = board();
		expect(boardRole(b.id, ALICE)).toBe('owner');
		expect(listMembers(b.id, ALICE)?.map((m) => m.username)).toEqual(['alice']);
	});

	it('arrives usable — lanes and statuses, with exactly one that finishes a card', () => {
		const b = board();
		expect(listLanes(b.id).length).toBeGreaterThan(0);
		expect(listLanes(b.id).length).toBeLessThanOrEqual(MAX_LANES);
		expect(listStatuses(b.id).filter((s) => s.isDone)).toHaveLength(1);
	});

	it('does not name a lane after a status, so the two stay distinguishable', () => {
		const b = board();
		const laneNames = listLanes(b.id).map((l) => l.name.toLowerCase());
		for (const s of listStatuses(b.id)) {
			expect(laneNames).not.toContain(s.name.toLowerCase());
		}
	});
});

describe('access', () => {
	it('hides a board from someone who is not on it', () => {
		const b = board();
		expect(boardRole(b.id, BOB)).toBeNull();
		expect(listBoards(BOB)).toHaveLength(0);
		expect(createCard(b.id, BOB, { title: 'sneaky' })).toBeNull();
	});

	it('lets a collaborator work on cards but not on the board itself', () => {
		const b = board();
		expect(addMember(b.id, ALICE, 'bob').ok).toBe(true);

		expect(createCard(b.id, BOB, { title: 'Bins' })).not.toBeNull();
		// Renaming or shelving a shared board affects everyone on it.
		expect(updateBoard(b.id, BOB, { name: 'Bob’s board' })).toBeNull();
		expect(deleteBoard(b.id, BOB)).toBe(false);
	});

	it('refuses to invite someone who has never signed in', () => {
		const b = board();
		expect(addMember(b.id, ALICE, 'nobody')).toEqual({ ok: false, reason: 'no-such-user' });
	});

	it('refuses a duplicate invite and an invite from a collaborator', () => {
		const b = board();
		addMember(b.id, ALICE, 'bob');
		expect(addMember(b.id, ALICE, 'bob')).toEqual({ ok: false, reason: 'already-member' });
		expect(addMember(b.id, BOB, 'alice')).toEqual({ ok: false, reason: 'forbidden' });
	});

	it('lets a collaborator leave but never strands the board without its owner', () => {
		const b = board();
		addMember(b.id, ALICE, 'bob');
		expect(removeMember(b.id, ALICE, ALICE)).toBe(false);
		expect(removeMember(b.id, BOB, BOB)).toBe(true);
		expect(boardRole(b.id, BOB)).toBeNull();
	});
});

describe('cards', () => {
	it('starts in the first unfinished status, never in a done one', () => {
		const b = board();
		const card = createCard(b.id, ALICE, { title: 'Renew passport' })!;
		expect(listStatuses(b.id).find((s) => s.id === card.statusId)?.isDone).toBe(false);
		expect(card.archivedAt).toBeNull();
	});

	it('archives itself when it reaches a done status', () => {
		const b = board();
		const card = createCard(b.id, ALICE, { title: 'Renew passport' })!;

		const updated = updateCard(card.id, ALICE, { statusId: doneStatus(b.id).id })!;
		expect(updated.archivedAt).not.toBeNull();
		expect(listCards(b.id)).toHaveLength(0);
		expect(listArchivedCards(b.id).map((c) => c.id)).toEqual([card.id]);
	});

	it('comes back off the archive when moved to an unfinished status', () => {
		const b = board();
		const card = createCard(b.id, ALICE, { title: 'Renew passport' })!;
		updateCard(card.id, ALICE, { statusId: doneStatus(b.id).id });

		const open = listStatuses(b.id).find((s) => !s.isDone)!;
		expect(updateCard(card.id, ALICE, { statusId: open.id })!.archivedAt).toBeNull();
		expect(listCards(b.id)).toHaveLength(1);
	});

	it('numbers cards in a lane contiguously as they are added and moved', () => {
		const b = board();
		const lanes = listLanes(b.id);
		const a = createCard(b.id, ALICE, { title: 'A', laneId: lanes[0].id })!;
		const c = createCard(b.id, ALICE, { title: 'B', laneId: lanes[0].id })!;
		expect([a.position, c.position]).toEqual([0, 1]);

		// Moving B to the front renumbers rather than leaving a gap or a tie.
		updateCard(c.id, ALICE, { laneId: lanes[0].id, position: 0 });
		const order = listCards(b.id)
			.filter((x) => x.laneId === lanes[0].id)
			.map((x) => `${x.title}:${x.position}`);
		expect(order).toEqual(['B:0', 'A:1']);
	});

	it('moves a card between lanes', () => {
		const b = board();
		const [from, to] = listLanes(b.id);
		const card = createCard(b.id, ALICE, { title: 'Move me', laneId: from.id })!;
		expect(updateCard(card.id, ALICE, { laneId: to.id })!.laneId).toBe(to.id);
	});
});

describe('the log', () => {
	it('records creation and every field that actually moved', () => {
		const b = board();
		const card = createCard(b.id, ALICE, { title: 'Book plumber' })!;
		updateCard(card.id, ALICE, { title: 'Book the plumber', priority: 'high' });

		const events = getCard(card.id, ALICE)!.log.map((l) => l.event);
		expect(events).toEqual(['created', 'renamed', 'priority']);
	});

	it('keeps cause before effect when both land in the same millisecond', () => {
		// Finishing a card writes "status" and then "archived" in one call. Both
		// carry the same timestamp, so anything that tie-breaks on the row's uuid
		// reorders them at random — the log has to read in insertion order.
		const b = board();
		const card = createCard(b.id, ALICE, { title: 'Renew passport' })!;
		updateCard(card.id, ALICE, { statusId: doneStatus(b.id).id });

		expect(getCard(card.id, ALICE)!.log.map((l) => l.event)).toEqual([
			'created',
			'status',
			'archived'
		]);
	});

	it('says nothing when nothing changed', () => {
		const b = board();
		const card = createCard(b.id, ALICE, { title: 'Book plumber' })!;
		updateCard(card.id, ALICE, { title: 'Book plumber', priority: 'none' });
		expect(getCard(card.id, ALICE)!.log.map((l) => l.event)).toEqual(['created']);
	});

	it('marks agent activity apart from the user’s', () => {
		const b = board();
		const card = createCard(b.id, ALICE, { title: 'Draft email' })!;
		updateCard(card.id, ALICE, { description: 'to the school' }, 'agent');

		const last = getCard(card.id, ALICE)!.log.at(-1)!;
		expect(last.actor).toBe('agent');
		// Still attributed to the person the agent was working for.
		expect(last.userId).toBe(ALICE);
	});
});

describe('lanes and statuses', () => {
	it('caps lanes, because they are columns on a screen', () => {
		const b = board();
		while (listLanes(b.id).length < MAX_LANES) {
			expect(addLane(b.id, ALICE, 'More').ok).toBe(true);
		}
		expect(addLane(b.id, ALICE, 'Too many')).toEqual({ ok: false, reason: 'limit' });
	});

	it('moves cards out of a removed lane instead of deleting them', () => {
		const b = board();
		const [first, second] = listLanes(b.id);
		const card = createCard(b.id, ALICE, { title: 'Keep me', laneId: second.id })!;

		expect(deleteLane(second.id, ALICE)).toBe(true);
		expect(getCard(card.id, ALICE)!.card.laneId).toBe(first.id);
	});

	it('never removes the last lane, which would leave cards nowhere to sit', () => {
		const b = board();
		const lanes = listLanes(b.id);
		for (const lane of lanes.slice(1)) deleteLane(lane.id, ALICE);
		expect(deleteLane(lanes[0].id, ALICE)).toBe(false);
	});

	it('moves cards off a removed status onto the first one', () => {
		const b = board();
		const extra = addStatus(b.id, ALICE, { name: 'Waiting' })!;
		const card = createCard(b.id, ALICE, { title: 'Chase', statusId: extra.id })!;

		expect(deleteStatus(extra.id, ALICE)).toBe(true);
		expect(getCard(card.id, ALICE)!.card.statusId).toBe(listStatuses(b.id)[0].id);
	});
});

describe('deleting a board', () => {
	it('takes its cards, lanes, statuses, members and log with it', () => {
		const b = board();
		addMember(b.id, ALICE, 'bob');
		const card = createCard(b.id, ALICE, { title: 'Gone' })!;

		expect(deleteBoard(b.id, ALICE)).toBe(true);
		expect(listBoards(ALICE)).toHaveLength(0);
		expect(listBoards(BOB)).toHaveLength(0);
		expect(db.select().from(cards).all()).toHaveLength(0);
		expect(db.select().from(cardLog).all()).toHaveLength(0);
		expect(db.select().from(boardLanes).all()).toHaveLength(0);
		expect(db.select().from(boardStatuses).all()).toHaveLength(0);
		expect(db.select().from(boardMembers).all()).toHaveLength(0);
		expect(getCard(card.id, ALICE)).toBeNull();
	});

	it('archiving hides it from the picker without losing anything', () => {
		const b = board();
		createCard(b.id, ALICE, { title: 'Still here' });

		updateBoard(b.id, ALICE, { archived: true });
		expect(listBoards(ALICE)).toHaveLength(0);
		expect(listBoards(ALICE, true)).toHaveLength(1);
		expect(listCards(b.id)).toHaveLength(1);
	});
});
