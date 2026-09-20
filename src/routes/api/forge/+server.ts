import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireCoder, requireUser } from '$lib/server/api';
import { createEpic, listEpics, listSprints, listTasks } from '$lib/server/forge';
import { runCharter } from '$lib/server/engine/forge-charter';
import { BudgetExceededError } from '$lib/server/engine/budget';
import { EngineError } from '$lib/server/engine/engine';

/** Every epic the caller owns, with enough counts to render a list. */
export const GET: RequestHandler = ({ locals }) => {
	const user = requireUser(locals);
	return json(
		listEpics(user.id).map((epic) => {
			const tasks = listTasks(epic.id);
			return {
				...epic,
				sprints: listSprints(epic.id).length,
				tasks: tasks.length,
				done: tasks.filter((t) => t.state === 'done').length,
				blocked: tasks.filter((t) => t.state === 'blocked').length
			};
		})
	);
};

/**
 * Start a build: create the epic, then write its charter.
 *
 * The charter run is awaited rather than backgrounded. It is the one part a
 * person is sitting and waiting for — there is nothing to look at until it
 * lands — and it reads a repository rather than writing one, so it is minutes
 * at worst rather than the twenty a coding turn can take.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
	const user = requireCoder(locals);
	const body = await request.json().catch(() => ({}));
	const title = typeof body.title === 'string' ? body.title.trim() : '';
	const repoUrl = typeof body.repoUrl === 'string' ? body.repoUrl.trim() : '';
	if (!title) error(400, 'title is required');
	if (!repoUrl) error(400, 'repoUrl is required');

	try {
		const epic = createEpic({
			ownerId: user.id,
			title,
			brief: typeof body.brief === 'string' ? body.brief : '',
			repoUrl,
			repoName: typeof body.repoName === 'string' ? body.repoName : '',
			baseBranch: typeof body.baseBranch === 'string' ? body.baseBranch : ''
		});
		const charter = await runCharter(epic, user.id);
		return json({ epic, charter }, { status: 201 });
	} catch (err) {
		if (err instanceof BudgetExceededError) error(402, err.message);
		if (err instanceof EngineError) error(400, err.message);
		throw err;
	}
};
