import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { forgeEpics, type ForgeTaskState } from '$lib/server/db/schema';
import {
	addLane,
	addProject,
	createCard,
	createBoard,
	listLanes,
	listProjects,
	logCard,
	renameLane,
	updateCard
} from '$lib/server/boards';
import { setTaskState, type ForgeEpic, type ForgeSprint, type ForgeTask } from '$lib/server/forge';
import { emitEvent } from './events';

/**
 * The epic, mirrored onto a board somebody can watch.
 *
 * Optional, one-way, and never load-bearing. The tree is the truth and the
 * board is a view of it: card state follows task state and never the reverse,
 * because two writers on one piece of state is a race, and a board that looks
 * editable but quietly loses the edit is worse than one that admits it is a
 * view.
 *
 * Every function here swallows its own failure. A board write that throws must
 * not fail the step that made it — the same rule that keeps a search provider
 * falling over from aborting a Feed trawl. An epic whose board was deleted
 * underneath it carries on building; it just stops being watchable.
 */

/**
 * Lane per task state, because a lane is the thing a board renders as a column
 * and the state is what somebody scanning the board wants to know.
 *
 * Four, which is under `MAX_LANES` with one spare. `gating` shares Running: a
 * task whose gate is being run has not stopped being in progress, and a column
 * that flickers for the thirty seconds a test suite takes tells nobody
 * anything.
 */
const LANES: Record<ForgeTaskState, string> = {
	planned: 'Queued',
	running: 'Running',
	gating: 'Running',
	blocked: 'Blocked',
	done: 'Done'
};
const LANE_NAMES = ['Queued', 'Running', 'Blocked', 'Done'];

/** Swallow, file, carry on. The only error policy this module has. */
function quietly<T>(what: string, epicId: string, fn: () => T): T | null {
	try {
		return fn();
	} catch (err) {
		noted(what, epicId, String(err).slice(0, 300));
		return null;
	}
}

/**
 * Say a mirror write did not land.
 *
 * Needed as much for the writes that *return* nothing as for the ones that
 * throw. Deleting a board does not delete the epic pointing at it, and every
 * call here then quietly does nothing: `boardRole` finds no membership so
 * `updateCard` answers null, and a board whose lanes are gone has no lane to
 * move to. Without this the mirror simply stops being a mirror, and the first
 * anybody knows is an empty board next to a build that is plainly working.
 */
function noted(what: string, epicId: string, reason: string): void {
	emitEvent({
		task: 'forge',
		type: 'job',
		name: 'forge.mirror',
		status: 'error',
		detail: { epicId, what, reason }
	});
}

/**
 * Give an epic a board, once.
 *
 * The four lanes are made by renaming the three a new board ships with and
 * adding one, rather than deleting and recreating: `deleteLane` moves every
 * card on it, and doing that to a board seconds after making it is a lot of
 * writing to arrive at the same four columns.
 */
export function ensureEpicBoard(epic: ForgeEpic, userId: string): string | null {
	if (epic.boardId) return epic.boardId;
	return quietly('create board', epic.id, () => {
		const board = createBoard({
			ownerId: userId,
			name: epic.title,
			description: `Mirrored from Forge. The build is the truth; this is a view of it.`
		});
		const existing = listLanes(board.id);
		LANE_NAMES.forEach((name, i) => {
			if (existing[i]) renameLane(existing[i].id, userId, name);
			else addLane(board.id, userId, name);
		});
		db.update(forgeEpics).set({ boardId: board.id }).where(eq(forgeEpics.id, epic.id)).run();
		return board.id;
	});
}

/** A sprint is a project: "a strand of work running across a board", already. */
export function mirrorSprint(epic: ForgeEpic, sprint: ForgeSprint, userId: string): string | null {
	if (!epic.boardId) return null;
	return quietly('add project', epic.id, () => {
		const boardId = epic.boardId as string;
		const existing = listProjects(boardId).find((p) => p.name === sprint.title);
		if (existing) return existing.id;
		const added = addProject(boardId, userId, { name: sprint.title });
		if (!added) noted('add project', epic.id, 'the board is gone or not ours');
		return added?.id ?? null;
	});
}

/**
 * Open a card for a task, in the lane its state says.
 *
 * The status is left wherever `createCard` puts it and never patched again.
 * Deliberate: `updateCard` archives a card the moment it reaches a status with
 * `isDone`, which is right for a household board and wrong for a sprint
 * somebody wants to read back afterwards.
 */
export function mirrorTask(
	epic: ForgeEpic,
	sprint: ForgeSprint,
	task: ForgeTask,
	userId: string
): void {
	if (!epic.boardId || task.cardId) return;
	quietly('open card', epic.id, () => {
		const boardId = epic.boardId as string;
		const projectId = listProjects(boardId).find((p) => p.name === sprint.title)?.id ?? null;
		const card = createCard(boardId, userId, {
			title: task.title,
			description: task.intent,
			laneId: laneFor(boardId, task.state),
			projectId
		});
		if (!card) return noted('open card', epic.id, 'the board is gone or not ours');
		setTaskState(task.id, task.state, { cardId: card.id });
	});
}

/**
 * Move a task's card to match, and say why in the card's own log.
 *
 * `card_log` rather than a comment, because it is already the card's audit
 * trail and already the thing an agent picking the card up reads.
 */
export function mirrorTaskState(
	epic: ForgeEpic,
	task: ForgeTask,
	userId: string,
	note = ''
): void {
	if (!epic.boardId || !task.cardId) return;
	quietly('move card', epic.id, () => {
		const laneId = laneFor(epic.boardId as string, task.state);
		const moved = laneId ? updateCard(task.cardId as string, userId, { laneId }, 'agent') : null;
		if (!moved) return noted('move card', epic.id, 'the board, its lanes or the card are gone');
		logCard(task.cardId as string, {
			actor: 'agent',
			userId,
			event: task.state,
			detail: note
		});
	});
}

function laneFor(boardId: string, state: ForgeTaskState): string | undefined {
	const want = LANES[state];
	return listLanes(boardId).find((l) => l.name === want)?.id;
}
