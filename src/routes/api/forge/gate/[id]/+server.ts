import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { getGateRun } from '$lib/server/forge';

/**
 * One gate run, with every check's command and output.
 *
 * Its own route rather than part of the tree: the tree is read on every poll
 * and a gate run carries the tail of each check's stdout, so folding these in
 * would make the common read carry kilobytes nobody had opened yet.
 */
export const GET: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	// Scoped in the SQL predicate, and 404 rather than 403: a gate run that is
	// not yours must be indistinguishable from one that does not exist.
	const run = getGateRun(params.id, user.id);
	if (!run) error(404, 'Gate run not found');
	return json(run);
};
