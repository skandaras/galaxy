import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, runMigrations } from '$lib/server/db';
import {
	boardLanes,
	boardMembers,
	boardProjects,
	boardStatuses,
	boards,
	cardLog,
	cards,
	events,
	forgeEpics,
	forgeSprints,
	forgeTasks,
	users,
	type ForgeCheck
} from '$lib/server/db/schema';
import { listLanes, listProjects, listStatuses } from '$lib/server/boards';
import {
	addSprint,
	approveEpic,
	createEpic,
	getEpic,
	listTasks,
	openTask,
	type ForgeEpic
} from '$lib/server/forge';
import {
	ensureEpicBoard,
	mirrorSprint,
	mirrorTask,
	mirrorTaskState
} from './forge-mirror';

/**
 * The board as a view of the build.
 *
 * Everything here is about the mirror not mattering: it is optional, it is
 * one-way, and its failure is never the step's. The cases that would be easy to
 * get wrong are the archive one — a board that quietly swallowed every finished
 * task would look like a build that had done nothing — and the failure one.
 */

const ALICE = 'user-alice';
const CHECKS: ForgeCheck[] = [{ name: 'ok', command: 'true', timeoutMs: 1000 }];

beforeAll(() => runMigrations());

beforeEach(() => {
	db.delete(cardLog).run();
	db.delete(cards).run();
	db.delete(boardProjects).run();
	db.delete(boardLanes).run();
	db.delete(boardStatuses).run();
	db.delete(boardMembers).run();
	db.delete(boards).run();
	db.delete(forgeTasks).run();
	db.delete(forgeSprints).run();
	db.delete(forgeEpics).run();
	db.delete(events).run();
	db.delete(users).run();
	db.insert(users)
		.values({
			id: ALICE,
			username: 'alice',
			isAdmin: false,
			canCode: true,
			createdAt: new Date(),
			lastSeenAt: new Date()
		})
		.run();
});

/** A mirrored epic with one sprint and one task, ready to move about. */
function mirrored() {
	const created = createEpic({ ownerId: ALICE, title: 'Build', repoUrl: 'file:///tmp/x' });
	approveEpic(created.id, ALICE, { standingChecks: CHECKS });
	ensureEpicBoard(getEpic(created.id, ALICE) as ForgeEpic, ALICE);
	const epic = getEpic(created.id, ALICE) as ForgeEpic;
	const sprint = addSprint({ epicId: epic.id, title: 'Sprint one', goal: 'it works' });
	mirrorSprint(epic, sprint, ALICE);
	const task = openTask({
		epicId: epic.id,
		sprintId: sprint.id,
		title: 'Do the thing',
		intent: 'the thing gets done',
		checks: CHECKS
	});
	mirrorTask(epic, sprint, task, ALICE);
	return { epic, sprint, task: listTasks(epic.id)[0] };
}

const cardRow = (id: string) => db.select().from(cards).where(eq(cards.id, id)).get();
const laneOf = (cardId: string) => {
	const card = cardRow(cardId)!;
	return listLanes(card.boardId).find((l) => l.id === card.laneId)?.name;
};

describe('the board an epic gets', () => {
	it('has a lane per task state and no more', () => {
		const { epic } = mirrored();
		expect(listLanes(epic.boardId!).map((l) => l.name)).toEqual([
			'Queued',
			'Running',
			'Blocked',
			'Done'
		]);
	});

	it('is made once, however often it is asked for', () => {
		const { epic } = mirrored();
		expect(ensureEpicBoard(epic, ALICE)).toBe(epic.boardId);
		expect(db.select().from(boards).all()).toHaveLength(1);
	});

	it('is not made at all for an epic that did not ask', () => {
		const epic = createEpic({ ownerId: ALICE, title: 'Unmirrored', repoUrl: 'file:///tmp/x' });
		const sprint = addSprint({ epicId: epic.id, title: 'One' });
		const task = openTask({ epicId: epic.id, sprintId: sprint.id, title: 'A', checks: CHECKS });

		mirrorSprint(epic, sprint, ALICE);
		mirrorTask(epic, sprint, task, ALICE);
		mirrorTaskState(epic, { ...task, state: 'done' }, ALICE);
		expect(db.select().from(boards).all()).toHaveLength(0);
		expect(db.select().from(cards).all()).toHaveLength(0);
	});
});

describe('a sprint and its tasks', () => {
	it('becomes a project with the tasks labelled by it', () => {
		const { epic, task } = mirrored();
		const projects = listProjects(epic.boardId!);
		expect(projects.map((p) => p.name)).toEqual(['Sprint one']);
		expect(cardRow(task.cardId!)?.projectId).toBe(projects[0].id);
	});

	it('does not gain a second project when planning runs again', () => {
		const { epic, sprint } = mirrored();
		mirrorSprint(epic, sprint, ALICE);
		expect(listProjects(epic.boardId!)).toHaveLength(1);
	});

	it('opens its card in Queued, carrying the task’s intent', () => {
		const { task } = mirrored();
		expect(laneOf(task.cardId!)).toBe('Queued');
		expect(cardRow(task.cardId!)?.description).toBe('the thing gets done');
	});

	it('does not open a second card for a task that has one', () => {
		const { epic, sprint, task } = mirrored();
		mirrorTask(epic, sprint, task, ALICE);
		expect(db.select().from(cards).all()).toHaveLength(1);
	});
});

describe('state maps to a lane', () => {
	it('moves the card as the task moves', () => {
		const { epic, task } = mirrored();
		mirrorTaskState(epic, { ...task, state: 'running' }, ALICE, 'attempt 1');
		expect(laneOf(task.cardId!)).toBe('Running');

		mirrorTaskState(epic, { ...task, state: 'blocked' }, ALICE, 'out of attempts');
		expect(laneOf(task.cardId!)).toBe('Blocked');

		mirrorTaskState(epic, { ...task, state: 'done' }, ALICE, 'merged');
		expect(laneOf(task.cardId!)).toBe('Done');
	});

	it('leaves a gating task in Running', () => {
		// A task whose gate is being run has not stopped being in progress, and a
		// column that flickers for the thirty seconds a test suite takes tells
		// nobody anything.
		const { epic, task } = mirrored();
		mirrorTaskState(epic, { ...task, state: 'gating' }, ALICE);
		expect(laneOf(task.cardId!)).toBe('Running');
	});

	it('narrates into the card’s own log, which is what an agent reads', () => {
		const { epic, task } = mirrored();
		mirrorTaskState(epic, { ...task, state: 'blocked' }, ALICE, 'its gate never passed');

		const lines = db.select().from(cardLog).where(eq(cardLog.cardId, task.cardId!)).all();
		const mine = lines.find((l) => l.event === 'blocked');
		expect(mine?.actor).toBe('agent');
		expect(mine?.detail).toBe('its gate never passed');
	});
});

describe('nothing auto-archives', () => {
	it('keeps a finished task on the board', () => {
		// updateCard archives a card the moment it reaches a status with isDone,
		// which is right for a household board and wrong for a sprint somebody
		// wants to read back afterwards. So the status never moves — only the lane.
		const { epic, task } = mirrored();
		const opened = cardRow(task.cardId!)!.statusId;
		mirrorTaskState(epic, { ...task, state: 'done' }, ALICE, 'merged');

		const after = cardRow(task.cardId!)!;
		expect(after.archivedAt).toBeNull();
		expect(after.statusId).toBe(opened);
		expect(listStatuses(epic.boardId!).find((s) => s.id === after.statusId)?.isDone).toBe(false);
	});
});

describe('a board write that fails', () => {
	it('is an event rather than a throw', () => {
		// The rule that keeps a mirror from being load-bearing: the step that made
		// this call has already written the tree, and the tree is the truth.
		const { epic, task } = mirrored();
		db.delete(cardLog).run();
		db.delete(cards).run();
		db.delete(boardLanes).run();
		db.delete(boardMembers).run();
		db.delete(boards).run();

		expect(() => mirrorTaskState(epic, { ...task, state: 'done' }, ALICE, 'merged')).not.toThrow();
		const filed = db.select().from(events).all();
		expect(filed.some((e) => e.name === 'forge.mirror' && e.status === 'error')).toBe(true);
	});
});
