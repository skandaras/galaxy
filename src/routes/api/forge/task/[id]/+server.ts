import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireCoder } from '$lib/server/api';
import { amendTask, getEpic, getTask } from '$lib/server/forge';
import { readChecks } from '$lib/server/engine/tools/forge';
import {
	DEFAULT_CHECK_TIMEOUT_MS,
	validateChecks
} from '$lib/server/engine/forge-gate';
import { withWorkspace } from '$lib/server/engine/forge-agent';
import { emitEvent } from '$lib/server/engine/events';

/**
 * Give a parked task a different contract.
 *
 * Without this the only way past one bad check is to abandon the build, which
 * is what happened the first time somebody hit it. A task blocked on a command
 * nothing can run is not a task that failed; it is a task that was never
 * properly asked.
 *
 * The checks are taken as written — no baseline re-run. That rule exists to
 * stop a *run* writing itself a check it cannot fail, and a person editing a
 * task that has already stopped is the case it was never about. Re-baselining
 * would also refuse a correct check that an earlier attempt has since made
 * pass, which would leave the task parked with no way out at all.
 *
 * What is still enforced is that the thing runs. That is the failure this whole
 * route exists because of, and a person can type a sentence as easily as a
 * model can.
 */
export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	const user = requireCoder(locals);
	const task = getTask(params.id, user.id);
	// Scoped through the epic's owner in the SQL predicate: somebody else's task
	// is one that does not exist.
	if (!task) error(404, 'Task not found');
	const epic = getEpic(task.epicId, user.id);
	if (!epic) error(404, 'Task not found');

	const body = await request.json().catch(() => ({}));
	const checks = readChecks(body.checks, DEFAULT_CHECK_TIMEOUT_MS);
	const noCheckReason = typeof body.noCheckReason === 'string' ? body.noCheckReason : '';

	if (checks.length) {
		const verdict = await withWorkspace(epic.repoUrl, epic.integrationBranch, (ws) =>
			validateChecks({ checks, workspaceRel: ws.workspaceRel })
		);
		if (verdict.refused.length) {
			return json(
				{ error: 'Some of these are not commands this repository can run', refused: verdict.refused },
				{ status: 422 }
			);
		}
	}

	const result = amendTask(params.id, user.id, { checks, noCheckReason });
	if (!result.ok) {
		if (result.reason === 'not-found') error(404, 'Task not found');
		if (result.reason === 'not-blocked') {
			error(409, 'Only a task that has stopped can be given a different check');
		}
		error(400, 'A task needs checks, or a stated reason it has none');
	}

	emitEvent({
		userId: user.id,
		task: 'forge',
		type: 'admin',
		name: 'forge.task-amended',
		status: 'ok',
		detail: {
			epicId: epic.id,
			taskId: task.id,
			// Commands, not output: this is the audit trail for the one thing a
			// person may change about a frozen contract.
			was: (task.checks ?? []).map((c) => c.command),
			now: checks.map((c) => c.command)
		}
	});
	return json(result.task);
};
