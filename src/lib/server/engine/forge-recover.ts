import { and, eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { forgeSprints, forgeTasks } from '$lib/server/db/schema';
import {
	countAttempt,
	deleteEpic,
	listTasks,
	setSprintState,
	setTaskState,
	type ForgeEpic
} from '$lib/server/forge';
import { emitEvent } from './events';
import { cancelJob, findRunningJobForChat } from './jobs';
import { destroySession, getSession } from './coding/session';

/**
 * What a restart leaves half-done inside an epic.
 *
 * `closeAbandonedJobs` errors the job rows a dead process was holding, which is
 * enough for a chat turn: the row is the whole of it. A Forge task is two rows —
 * the job and the task — and only the first of them gets tidied, so without this
 * a build that was mid-task when the server went down has a task stuck at
 * `running` for ever. `tasksInFlight` counts it, the driver decides the epic is
 * at its concurrency limit, and the epic never moves again. This app updates
 * itself, so that is an ordinary Tuesday.
 *
 * Deliberately *not* symmetrical between the states:
 *
 * - A task at `running` goes back to `planned` with an attempt counted against
 *   it. Counting it is the point — a task that reliably takes the process down
 *   should eventually park rather than restart for ever.
 * - A sprint at `planning` goes back to `outlined`, with no attempt counted. A
 *   sprint's attempts are its gate's currency, and spending one here would park
 *   it early for a reason that had nothing to do with its code. This state is
 *   the quiet one: `nextStep` returns null on a planning sprint by design, so
 *   left alone it is not a stuck task but a silently stopped epic.
 * - Anything at `gating` is left exactly where it is. `code_sessions` is a table
 *   and its workspace is on disk, so the work a gate judges survives the restart
 *   that interrupted it, and `nextStep` already picks a gate up before anything
 *   else. Resetting it would throw away a finished attempt and charge it an
 *   attempt for the privilege.
 *
 * Safe to call while the server is up — it asks whether each task's job is live
 * rather than assuming it is not — but at boot it never has to, because the live
 * job map is empty by definition.
 *
 * `epicId` narrows it to one build, which is what resuming one needs: a run
 * abandoned mid-task comes back with its task still claiming to be running, so
 * `tasksInFlight` counts it, the sweep decides the epic is at its concurrency
 * limit and `nextStep` returns null. Resuming without this put a build back into
 * `running` and left it there doing nothing until the next restart.
 *
 * `cancel` is for a person stopping their own build rather than a process
 * dying. It ends the live job instead of stepping around it, and counts no
 * attempt: the boot path counts one because a task that reliably takes the
 * process down should eventually park, and somebody pressing Pause is not that.
 * Without it, abandoning stopped the epic and left the coding turn running, so
 * the runner carried on and so did the bill.
 */
export function reconcileForge(opts: { epicId?: string; cancel?: boolean } = {}): number {
	const { epicId, cancel } = opts;
	let moved = 0;

	for (const task of db
		.select()
		.from(forgeTasks)
		.where(
			and(eq(forgeTasks.state, 'running'), epicId ? eq(forgeTasks.epicId, epicId) : undefined)
		)
		.all()) {
		const live = task.chatId ? findRunningJobForChat(task.chatId) : null;
		if (live) {
			if (!cancel) continue;
			cancelJob(live);
		}
		const attempts = cancel ? task.attempts : countAttempt(task.id);
		setTaskState(task.id, 'planned');
		emitEvent({
			task: 'forge',
			type: 'job',
			name: 'forge.recovered',
			status: 'error',
			detail: { taskId: task.id, epicId: task.epicId, was: 'running', attempts, cancelled: !!live }
		});
		moved++;
	}

	for (const sprint of db
		.select()
		.from(forgeSprints)
		.where(
			and(
				eq(forgeSprints.state, 'planning'),
				epicId ? eq(forgeSprints.epicId, epicId) : undefined
			)
		)
		.all()) {
		setSprintState(sprint.id, 'outlined');
		emitEvent({
			task: 'forge',
			type: 'job',
			name: 'forge.recovered',
			status: 'error',
			detail: { sprintId: sprint.id, epicId: sprint.epicId, was: 'planning' }
		});
		moved++;
	}

	return moved;
}

export type PurgeResult = { ok: true; tasks: number } | { ok: false; reason: 'busy' };

/**
 * Delete a build, its rows and the workspaces its tasks were using.
 *
 * Refused while a task's turn is live, the way a coding session refuses to be
 * deleted mid-run: the turn would carry on writing to a workspace whose task
 * row had gone, and the job that outlived it has nothing left to report to.
 * Pausing first is what a person does about that, and it is one button along.
 *
 * `destroySession` per task is the same teardown a retry already does before it
 * re-clones, so the workspace, the chat and its messages go together. One cost
 * comes with it, already recorded on `forgeSpend`: deleting a chat nulls
 * `usage_log.chat_id`, so this build's spend leaves that sum. The platform-wide
 * cap still counts the money; only the attribution goes.
 */
export function purgeEpic(epic: ForgeEpic, userId: string): PurgeResult {
	const tasks = listTasks(epic.id);
	if (tasks.some((t) => t.chatId && findRunningJobForChat(t.chatId))) {
		return { ok: false, reason: 'busy' };
	}
	// Rows first would leave no way to find the workspaces if this threw.
	for (const task of tasks) {
		if (!task.chatId) continue;
		const session = getSession(task.chatId, userId);
		if (session) destroySession(session);
	}
	deleteEpic(epic.id, userId);
	emitEvent({
		userId,
		task: 'forge',
		type: 'job',
		name: 'forge.deleted',
		status: 'ok',
		detail: { epicId: epic.id, tasks: tasks.length }
	});
	return { ok: true, tasks: tasks.length };
}
