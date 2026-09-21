import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireCoder, requireUser } from '$lib/server/api';
import {
	gateRunsFor,
	getEpic,
	listSprints,
	listTasks,
	setEpicOverride,
	setEpicState
} from '$lib/server/forge';
import { describeStep, nextStep } from '$lib/server/engine/forge-step';
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
	// Resuming an epic that never got past its charter would start it with no
	// frozen checks, which is the one thing approval exists to prevent.
	if (action === 'resume' && !epic.approvedAt) {
		error(400, 'This epic has not been approved yet — confirm its checks first');
	}
	setEpicState(epic.id, STATES[action], typeof body.reason === 'string' ? body.reason : '');
	return json(getEpic(epic.id, user.id));
};
