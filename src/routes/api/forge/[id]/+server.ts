import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireCoder, requireUser } from '$lib/server/api';
import {
	gateRunsFor,
	getEpic,
	listSprints,
	listTasks,
	resumeState,
	setEpicOverride,
	setEpicState
} from '$lib/server/forge';
import { describeStep, nextStep } from '$lib/server/engine/forge-step';
import { purgeEpic, reconcileForge } from '$lib/server/engine/forge-recover';
import { forgeSettings } from '$lib/server/settings';

/**
 * The whole tree, with the latest gate against each unit — and what happens
 * next.
 *
 * `next` is the same pure `nextStep` the driver asks, put in words. The page
 * polls this while a build is live, so this one read has to answer both "where
 * has it got to" and "what is it about to do"; a button labelled *run one step
 * now* answered neither.
 */
export const GET: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	// Scoped in the SQL predicate: an epic that is not yours is one that does
	// not exist, because an epic names somebody's repository.
	const epic = getEpic(params.id, user.id);
	if (!epic) error(404, 'Epic not found');

	const sprints = listSprints(epic.id);
	const tasks = listTasks(epic.id);
	const latest = (id: string) => gateRunsFor(id, 1).find((r) => !r.baseline) ?? null;
	const snap = { epic, sprints, tasks };
	const step = nextStep(snap);
	const cfg = forgeSettings();
	return json({
		epic,
		driver: { enabled: cfg.enabled, stepsPerTick: cfg.stepsPerTick },
		next: step ? { kind: step.kind, says: describeStep(step, snap) } : null,
		sprints: sprints.map((sprint) => ({
			...sprint,
			gate: latest(sprint.id),
			tasks: tasks
				.filter((t) => t.sprintId === sprint.id)
				.map((task) => ({ ...task, gate: latest(task.id) }))
		}))
	});
};

const STATES = { pause: 'paused', resume: 'running', abandon: 'abandoned' } as const;

/**
 * Stop, restart or give up on a build, and set what it may spend.
 *
 * The override travels with the state change rather than in a route of its own,
 * because the two are almost always the same request: an epic that paused on
 * its ceiling is resumed by raising the ceiling, and doing that in two calls
 * means the next tick can pause it again in between.
 */
export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	const user = requireCoder(locals);
	const epic = getEpic(params.id, user.id);
	if (!epic) error(404, 'Epic not found');

	const body = await request.json().catch(() => ({}));
	const setsCeiling = body.maxUsdOverride !== undefined;

	// Before the state change, not after: `{ action: 'resume', maxUsdOverride }`
	// has to raise the ceiling first or the next tick pauses the epic again on
	// the cap it was just resumed past.
	//
	// Clamped here as well as wherever a form asks for it, for the reason
	// normaliseForgeSettings gives — a min/max does not survive a raw API call,
	// and this number decides how much an unattended agent may spend. Not
	// floored: a £12.50 ceiling has to survive the round trip.
	if (setsCeiling) {
		const usd = Number(body.maxUsdOverride);
		if (!Number.isFinite(usd) || usd < 0) error(400, 'maxUsdOverride must be 0 or more');
		setEpicOverride(epic.id, Math.min(10_000, usd));
	}
	// A ceiling on its own is a whole request: lowering one to stop a build after
	// whatever it is doing now is as reasonable as raising one to let it carry on.
	if (setsCeiling && body.action === undefined) return json(getEpic(epic.id, user.id));

	const action = body.action as keyof typeof STATES;
	if (!(action in STATES)) {
		error(400, `Unknown action. Try one of: ${Object.keys(STATES).join(', ')}`);
	}
	// Where a resume lands is `resumeState`'s answer rather than a flat
	// `running`: an epic abandoned before approval has no frozen checks to run
	// with, and starting it anyway is the one thing approval exists to prevent.
	const to = action === 'resume' ? resumeState(epic) : STATES[action];
	// The state first, then the rows. `startTask`'s subscriber asks whether the
	// epic is still running before it moves a finished turn to `gating`, so the
	// state has to be off `running` before anything cancels a job — otherwise a
	// turn that unwound in between would drag the task it belongs to into a gate
	// against a workspace holding half an attempt.
	setEpicState(epic.id, to, typeof body.reason === 'string' ? body.reason : '');
	// Stopping means stopping the work too. Setting the state alone left the
	// coding turn the build was in the middle of running, so the page said
	// paused while the runner carried on and the bill with it.
	//
	// Picking one back up runs the same reconcile without the cancel, because a
	// task still claiming to be running is one `tasksInFlight` counts and
	// `nextStep` will not step past: a build resumed without this went back to
	// `running` and sat there until the next restart.
	reconcileForge({ epicId: epic.id, cancel: action !== 'resume' });
	return json(getEpic(epic.id, user.id));
};

/**
 * Delete a build outright.
 *
 * Its rows and its tasks' workspaces go; the charter and the records stay in
 * the Library, where `deleteDoc` promotes children rather than cascading, and
 * the integration branch stays on the remote, where it is the only remaining
 * copy of anything that never merged. Refused while a turn is live, the way a
 * coding session is.
 */
export const DELETE: RequestHandler = ({ locals, params }) => {
	const user = requireCoder(locals);
	const epic = getEpic(params.id, user.id);
	if (!epic) error(404, 'Epic not found');
	const outcome = purgeEpic(epic, user.id);
	if (!outcome.ok) {
		// Both readings, because a pause asks the turn to stop and the turn is
		// what ends it: somebody who has just pressed Pause gets this too, and
		// telling them to pause is no use to them.
		error(409, 'A task is still running. Pause this build if you have not, and try again once its turn has stopped.');
	}
	return json({ ok: true });
};
