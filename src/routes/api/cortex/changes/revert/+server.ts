import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { revertChange, revertRun } from '$lib/server/cortex';

export const POST: RequestHandler = async ({ locals, request }) => {
	const user = requireUser(locals);
	const body = await request.json().catch(() => ({}));
	if (typeof body.runId === 'string') return json({ reverted: revertRun(body.runId, user.id) });
	if (typeof body.id !== 'string') error(400, 'id or runId is required');
	// Undo is what makes applying anything automatically defensible: a change you
	// cannot undo is a decision taken for you.
	if (!revertChange(body.id, user.id)) error(404, 'Nothing to undo for that change');
	return json({ reverted: 1 });
};
