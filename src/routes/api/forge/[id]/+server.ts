import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireCoder, requireUser } from '$lib/server/api';
import {
	gateRunsFor,
	getEpic,
	listSprints,
	listTasks,
	setEpicState
} from '$lib/server/forge';

/** The whole tree, with the latest gate against each unit. */
export const GET: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	// Scoped in the SQL predicate: an epic that is not yours is one that does
	// not exist, because an epic names somebody's repository.
	const epic = getEpic(params.id, user.id);
	if (!epic) error(404, 'Epic not found');

	const tasks = listTasks(epic.id);
	const latest = (id: string) => gateRunsFor(id, 1).find((r) => !r.baseline) ?? null;
	return json({
		epic,
		sprints: listSprints(epic.id).map((sprint) => ({
			...sprint,
			gate: latest(sprint.id),
			tasks: tasks
				.filter((t) => t.sprintId === sprint.id)
				.map((task) => ({ ...task, gate: latest(task.id) }))
		}))
	});
};

const STATES = { pause: 'paused', resume: 'running', abandon: 'abandoned' } as const;

/** Stop, restart or give up on a build. */
export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	const user = requireCoder(locals);
	const epic = getEpic(params.id, user.id);
	if (!epic) error(404, 'Epic not found');

	const body = await request.json().catch(() => ({}));
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
