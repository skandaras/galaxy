import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireCoder, requireUser } from '$lib/server/api';
import { createEpic, getEpic, listEpics, listSprints, listTasks } from '$lib/server/forge';
import { runCharter } from '$lib/server/engine/forge-charter';
import { ensureEpicBoard } from '$lib/server/engine/forge-mirror';
import { BudgetExceededError } from '$lib/server/engine/budget';
import { EngineError } from '$lib/server/engine/engine';
import { forgeSettings } from '$lib/server/settings';

/**
 * Every epic the caller owns, with enough counts to render a list — and whether
 * the driver is switched on at all.
 *
 * The driver's two dials travel with the list because without them a build that
 * will never move looks exactly like one that is about to. `running` with Forge
 * disabled is the most confusing state the page can be in, and it is the page
 * that has to say so. Two fields, not the settings row: somebody looking at
 * their own build is not thereby an admin.
 */
export const GET: RequestHandler = ({ locals }) => {
	const user = requireUser(locals);
	const cfg = forgeSettings();
	return json({
		driver: { enabled: cfg.enabled, stepsPerTick: cfg.stepsPerTick },
		epics: listEpics(user.id).map((epic) => {
			const tasks = listTasks(epic.id);
			return {
				...epic,
				sprints: listSprints(epic.id).length,
				tasks: tasks.length,
				done: tasks.filter((t) => t.state === 'done').length,
				blocked: tasks.filter((t) => t.state === 'blocked').length
			};
		})
	});
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
		// Before the charter rather than after: the board is what somebody watches
		// the build on, and the charter run is the first minutes of it. `boardId`
		// being set *is* the mirror being on, so this is the one place it is
		// decided — the mirror never turns itself on later.
		if (body.mirror === true) ensureEpicBoard(epic, user.id);
		const charter = await runCharter(epic, user.id);
		return json({ epic: getEpic(epic.id, user.id) ?? epic, charter }, { status: 201 });
	} catch (err) {
		if (err instanceof BudgetExceededError) error(402, err.message);
		if (err instanceof EngineError) error(400, err.message);
		throw err;
	}
};
