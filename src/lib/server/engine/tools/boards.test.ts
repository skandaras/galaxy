import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, runMigrations } from '$lib/server/db';
import {
	boardLanes,
	boardMembers,
	boardProjects,
	boardStatuses,
	boards,
	cardLog,
	cards,
	settings,
	users
} from '$lib/server/db/schema';
import {
	addMember,
	createBoard,
	createCard,
	getCard,
	listBoards,
	listCards,
	listLanes,
	listProjects,
	listStatuses,
	MAX_LANES
} from '$lib/server/boards';
import { setSetting } from '$lib/server/settings';
import { boardTools, boardsDigest } from './boards';
import type { LoopTool } from '../loop';

const ALICE = 'user-alice';
const BOB = 'user-bob';

beforeAll(() => {
	runMigrations();
});

beforeEach(() => {
	for (const t of [
		cardLog,
		cards,
		boardLanes,
		boardStatuses,
		boardProjects,
		boardMembers,
		boards,
		users
	]) {
		db.delete(t).run();
	}
	db.delete(settings).run();
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

const tool = (tools: LoopTool[], name: string) => tools.find((t) => t.def.name === name);
const call = (tools: LoopTool[], name: string, args: Record<string, unknown>) => {
	const found = tool(tools, name);
	if (!found) throw new Error(`${name} is not offered`);
	return found.execute(args);
};

describe('what an agent can see', () => {
	it('reads only the boards its user is on', async () => {
		const mine = createBoard({ ownerId: ALICE, name: 'Household' });
		createBoard({ ownerId: BOB, name: 'Bob’s work' });
		createCard(mine.id, ALICE, { title: 'Renew passport' });

		const forAlice = await call(boardTools(ALICE), 'board_read', {});
		expect(forAlice).toContain('Household');
		expect(forAlice).toContain('Renew passport');

		const forBob = await call(boardTools(BOB), 'board_read', {});
		expect(forBob).not.toContain('Household');
		expect(forBob).not.toContain('Renew passport');
	});

	it('picks up a board once it is shared', async () => {
		const b = createBoard({ ownerId: ALICE, name: 'Household' });
		expect(await call(boardTools(BOB), 'board_read', {})).toBe('You have no boards.');

		addMember(b.id, ALICE, 'bob');
		expect(await call(boardTools(BOB), 'board_read', {})).toContain('Household');
	});

	it('will not read a card on someone else’s board, even given its id', async () => {
		const b = createBoard({ ownerId: ALICE, name: 'Household' });
		const card = createCard(b.id, ALICE, { title: 'Renew passport' })!;

		// Indistinguishable from a card that does not exist, so ids cannot be probed.
		await expect(call(boardTools(BOB), 'card_read', { cardId: card.id })).rejects.toThrow(
			`No card with id ${card.id}`
		);
	});

	it('reads a card with its log and attachment text', async () => {
		const b = createBoard({ ownerId: ALICE, name: 'Household' });
		const card = createCard(b.id, ALICE, {
			title: 'Book plumber',
			description: 'The kitchen tap drips'
		})!;

		const text = await call(boardTools(ALICE), 'card_read', { cardId: card.id });
		expect(text).toContain('Book plumber');
		expect(text).toContain('The kitchen tap drips');
		// The Log is what tells an agent what has already been tried.
		expect(text).toContain('## Log');
		expect(text).toContain('created');
	});

	it('keeps another user’s boards out of the context bootstrap', () => {
		createBoard({ ownerId: ALICE, name: 'Household' });
		expect(boardsDigest(ALICE)).toContain('Household');
		expect(boardsDigest(BOB)).toBe('(no boards)');
	});
});

describe('what an agent can change', () => {
	it('moves a card and records itself as the actor', async () => {
		const b = createBoard({ ownerId: ALICE, name: 'Household' });
		const card = createCard(b.id, ALICE, { title: 'Book plumber' })!;
		const done = listStatuses(b.id).find((s) => s.isDone)!;

		await call(boardTools(ALICE), 'card_update', { cardId: card.id, status: done.name });

		const detail = getCard(card.id, ALICE)!;
		expect(detail.card.archivedAt).not.toBeNull();
		const statusLine = detail.log.find((l) => l.event === 'status')!;
		expect(statusLine.actor).toBe('agent');
		// Still attributed to the person the agent was working for.
		expect(statusLine.userId).toBe(ALICE);
	});

	it('names the board’s real statuses when given one that does not exist', async () => {
		const b = createBoard({ ownerId: ALICE, name: 'Household' });
		const card = createCard(b.id, ALICE, { title: 'Book plumber' })!;

		await expect(
			call(boardTools(ALICE), 'card_update', { cardId: card.id, status: 'Shipped' })
		).rejects.toThrow(/No status called "Shipped".*To do/s);
	});

	it('writes a note to the log', async () => {
		const b = createBoard({ ownerId: ALICE, name: 'Household' });
		const card = createCard(b.id, ALICE, { title: 'Book plumber' })!;

		await call(boardTools(ALICE), 'card_comment', { cardId: card.id, note: 'Left a voicemail' });
		const last = getCard(card.id, ALICE)!.log.at(-1)!;
		expect(last).toMatchObject({ actor: 'agent', event: 'comment', detail: 'Left a voicemail' });
	});

	it('adds a card to a board it can see, by name', async () => {
		createBoard({ ownerId: ALICE, name: 'Household' });
		await call(boardTools(ALICE), 'card_add', { board: 'Household', title: 'Bins out' });
		expect((await call(boardTools(ALICE), 'board_read', {})).includes('Bins out')).toBe(true);
	});

	it('cannot add a card to a board it is not on', async () => {
		createBoard({ ownerId: ALICE, name: 'Household' });
		await expect(
			call(boardTools(BOB), 'card_add', { board: 'Household', title: 'Sneaky' })
		).rejects.toThrow('No board called "Household"');
	});
});

describe('shaping a board', () => {
	it('adds and renames a lane on a board it is on', async () => {
		const b = createBoard({ ownerId: ALICE, name: 'Household' });
		await call(boardTools(ALICE), 'lane_add', { board: 'Household', name: 'Waiting' });
		expect(listLanes(b.id).map((l) => l.name)).toContain('Waiting');

		await call(boardTools(ALICE), 'lane_rename', {
			board: 'Household',
			lane: 'Waiting',
			name: 'Parked'
		});
		expect(listLanes(b.id).map((l) => l.name)).toContain('Parked');
	});

	it('cannot touch a board it is not on', async () => {
		createBoard({ ownerId: ALICE, name: 'Household' });
		await expect(
			call(boardTools(BOB), 'lane_add', { board: 'Household', name: 'Sneaky' })
		).rejects.toThrow('No board called "Household"');
	});

	it('is told the lane cap rather than silently failing', async () => {
		const b = createBoard({ ownerId: ALICE, name: 'Household' });
		while (listLanes(b.id).length < MAX_LANES) {
			await call(boardTools(ALICE), 'lane_add', { board: 'Household', name: 'More' });
		}
		await expect(
			call(boardTools(ALICE), 'lane_add', { board: 'Household', name: 'Too many' })
		).rejects.toThrow(/maximum of 5 lanes/);
	});

	it('names the real lanes when asked to rename one that is not there', async () => {
		createBoard({ ownerId: ALICE, name: 'Household' });
		await expect(
			call(boardTools(ALICE), 'lane_rename', { board: 'Household', lane: 'Nope', name: 'x' })
		).rejects.toThrow(/No lane called "Nope".*Now/s);
	});

	it('creates a board, and obeys the cap that used to live in the route', async () => {
		setSetting('boards', { maxBoardsPerUser: 1, agentWrites: true });
		await call(boardTools(ALICE), 'board_add', { name: 'Weekend' });
		expect(listBoards(ALICE).map((b) => b.name)).toEqual(['Weekend']);

		await expect(call(boardTools(ALICE), 'board_add', { name: 'One too many' })).rejects.toThrow(
			/limit an admin has set/
		);
	});

	it('adds a project and can file a card against it by name', async () => {
		const b = createBoard({ ownerId: ALICE, name: 'Household' });
		await call(boardTools(ALICE), 'project_add', { board: 'Household', name: 'Kitchen' });
		expect(listProjects(b.id).map((p) => p.name)).toEqual(['Kitchen']);

		await call(boardTools(ALICE), 'card_add', {
			board: 'Household',
			title: 'Order tiles',
			project: 'Kitchen'
		});
		expect(listCards(b.id)[0].projectId).toBe(listProjects(b.id)[0].id);
	});

	it('refuses a project that is not on the board, and says what is', async () => {
		createBoard({ ownerId: ALICE, name: 'Household' });
		await expect(
			call(boardTools(ALICE), 'card_add', {
				board: 'Household',
				title: 'x',
				project: 'Nonexistent'
			})
		).rejects.toThrow(/No project called "Nonexistent"/);
	});

	it('is offered no way to delete a lane, project or board', () => {
		const names = boardTools(ALICE, true).map((t) => t.def.name);
		// Destructive board surgery stays a human action.
		expect(names.filter((n) => n.includes('delete') || n.includes('remove'))).toEqual([]);
	});
});

describe('when the admin turns agent writes off', () => {
	beforeEach(() => {
		setSetting('boards', { maxBoardsPerUser: 20, agentWrites: false });
	});

	it('withdraws the write tools but keeps the read ones', () => {
		const names = boardTools(ALICE).map((t) => t.def.name);
		expect(names).toContain('board_read');
		expect(names).toContain('card_read');
		expect(names).not.toContain('card_update');
		expect(names).not.toContain('card_comment');
		expect(names).not.toContain('card_add');
		// Structural tools are writes too — an agent that cannot tick a card off
		// certainly should not be reorganising the board.
		expect(names).not.toContain('lane_add');
		expect(names).not.toContain('board_add');
	});

	it('leaves cards untouched, since there is no tool to touch them with', () => {
		const b = createBoard({ ownerId: ALICE, name: 'Household' });
		createCard(b.id, ALICE, { title: 'Book plumber' });
		expect(tool(boardTools(ALICE), 'card_update')).toBeUndefined();
		expect(listCards(b.id)).toHaveLength(1);
	});

	it('still lists them in the admin catalogue, which asks for them explicitly', () => {
		// A control that vanishes when it is switched off is one nobody can find
		// their way back to.
		expect(boardTools('*', true).map((t) => t.def.name)).toContain('card_update');
	});
});
