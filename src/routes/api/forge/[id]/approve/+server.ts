import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireCoder } from '$lib/server/api';
import { approveEpic, getEpic } from '$lib/server/forge';
import { readChecks } from '$lib/server/engine/tools/forge';
import { DEFAULT_CHECK_TIMEOUT_MS, validateChecks } from '$lib/server/engine/forge-gate';
import { withWorkspace } from '$lib/server/engine/forge-agent';

/**
 * Confirm the checks and let the build start.
 *
 * The one moment a person is asked for anything, and the only door
 * `standingChecks` is ever written through. What arrives here is what the whole
 * safety argument rests on: after this, no run — and nothing a repository says
 * about itself — can change the commands its work is judged by.
 *
 * Which is exactly why it is checked first. The first real build was approved
 * with a sentence in the box — *"You create a test for this as part of the
 * plan."* — typed by somebody who reasonably expected it to be understood. It
 * was frozen verbatim, handed to a shell at every task gate, and answered
 * `You: not found` for the rest of the epic's life. Freezing is permanent, so
 * the validation belongs in front of it rather than in a comment asking people
 * to be careful.
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

	const verdict = await withWorkspace(epic.repoUrl, epic.baseBranch, (ws) =>
		validateChecks({ checks: [...standingChecks, ...gateChecks], workspaceRel: ws.workspaceRel })
	);
	if (verdict.refused.length) {
		// 422 rather than 400: the request was well formed and the commands in it
		// were not. The body names each one and quotes the shell, because "invalid
		// check" tells somebody nothing about which words were the problem.
		return json(
			{
				error: 'Some of these are not commands this repository can run',
				refused: verdict.refused,
				red: verdict.red
			},
			{ status: 422 }
		);
	}
	// A red check is a warning, not a refusal — a repository whose own tests are
	// failing today is a real situation and the person approving may know why.
	// They confirm once, and the second request carries `acceptRed`.
	if (verdict.red.length && body.acceptRed !== true) {
		return json(
			{
				error: 'These ran, but are not green on an untouched clone',
				refused: [],
				red: verdict.red
			},
			{ status: 409 }
		);
	}

	return json(approveEpic(epic.id, user.id, { standingChecks, gateChecks, acceptance }));
};
