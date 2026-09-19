import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireCoder } from '$lib/server/api';
import { approveEpic, getEpic } from '$lib/server/forge';
import { readChecks } from '$lib/server/engine/tools/forge';
import { DEFAULT_CHECK_TIMEOUT_MS } from '$lib/server/engine/forge-gate';

/**
 * Confirm the checks and let the build start.
 *
 * The one moment a person is asked for anything, and the only door
 * `standingChecks` is ever written through. What arrives here is what the whole
 * safety argument rests on: after this, no run — and nothing a repository says
 * about itself — can change the commands its work is judged by.
 */
export const POST: RequestHandler = async ({ locals, params, request }) => {
	const user = requireCoder(locals);
	const epic = getEpic(params.id, user.id);
	if (!epic) error(404, 'Epic not found');
	if (epic.approvedAt) error(409, 'This epic was already approved; its checks are frozen');

	const body = await request.json().catch(() => ({}));
	// The charter's proposal is the default, so approving without editing takes
	// what was proposed rather than nothing.
	const standingChecks = body.standingChecks
		? readChecks(body.standingChecks, DEFAULT_CHECK_TIMEOUT_MS)
		: (epic.standingChecks ?? []);
	if (!standingChecks.length) {
		error(400, 'At least one standing check is required — a build with no gate is not a build');
	}
	const gateChecks = body.gateChecks
		? readChecks(body.gateChecks, DEFAULT_CHECK_TIMEOUT_MS)
		: (epic.gateChecks ?? []);
	const acceptance = Array.isArray(body.acceptance)
		? body.acceptance.filter((a: unknown): a is string => typeof a === 'string')
		: (epic.acceptance ?? []);

	return json(approveEpic(epic.id, user.id, { standingChecks, gateChecks, acceptance }));
};
