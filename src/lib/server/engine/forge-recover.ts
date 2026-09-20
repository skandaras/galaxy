import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { forgeSprints, forgeTasks } from '$lib/server/db/schema';
import { countAttempt, setSprintState, setTaskState } from '$lib/server/forge';
import { emitEvent } from './events';
import { findRunningJobForChat } from './jobs';

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
 */
export function reconcileForge(): number {
	let moved = 0;

	for (const task of db
		.select()
		.from(forgeTasks)
		.where(eq(forgeTasks.state, 'running'))
		.all()) {
		if (task.chatId && findRunningJobForChat(task.chatId)) continue;
		const attempts = countAttempt(task.id);
		setTaskState(task.id, 'planned');
		emitEvent({
			task: 'forge',
			type: 'job',
			name: 'forge.recovered',
			status: 'error',
			detail: { taskId: task.id, epicId: task.epicId, was: 'running', attempts }
		});
		moved++;
	}

	for (const sprint of db
		.select()
		.from(forgeSprints)
		.where(eq(forgeSprints.state, 'planning'))
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
