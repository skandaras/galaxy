import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireCoder } from '$lib/server/api';
import { shelfClient } from '$lib/server/ivory/github';
import { shelfErrorMessage, shelfIndex } from '$lib/server/ivory/view';
import { ivorySettings } from '$lib/server/settings';
import { emitEvent } from '$lib/server/engine/events';
import { createProject, ProjectError } from '$lib/server/ivory/create';

// The Shelf index: projects grouped by discipline, with open-task counts from the board.
export const GET: RequestHandler = async ({ locals }) => {
	requireCoder(locals);
	const client = shelfClient();
	if (!client) return json({ configured: false, repo: ivorySettings().shelfRepo });
	try {
		return json({ configured: true, ...(await shelfIndex(client)) });
	} catch (err) {
		error(502, shelfErrorMessage(err, client.repo));
	}
};

// A new project from the form: the brief, its project issue and its first status line.
export const POST: RequestHandler = async ({ locals, request }) => {
	const user = requireCoder(locals);
	const client = shelfClient();
	if (!client) error(409, 'No GitHub token is configured. Add one in Admin → Settings → GitHub.');
	const body = await request.json().catch(() => ({}));
	try {
		const result = await createProject(client, body);
		emitEvent({
			userId: user.id,
			type: 'tool.call',
			name: 'ivory.create',
			status: result.warning ? 'error' : 'ok',
			detail: { slug: result.slug, warning: result.warning ?? null }
		});
		return json(result, { status: 201 });
	} catch (err) {
		// Field problems travel as JSON, keyed by field; App.Error has no place for them.
		if (err instanceof ProjectError) return json({ message: err.message, problems: err.problems }, { status: err.status });
		error(502, shelfErrorMessage(err, client.repo));
	}
};
