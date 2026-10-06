import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { decideCandidate } from '$lib/server/engine/memory';
import { emitEvent } from '$lib/server/engine/events';

/**
 * Decide a skill an agent proposed from the caller's own activity. Approving
 * makes it a skill of theirs. Another person's candidate is not found, in the
 * query itself; an admin decides anyone's from Admin.
 */
export const POST: RequestHandler = async ({ locals, params, request }) => {
	const user = requireUser(locals);
	const body = await request.json().catch(() => ({}));
	if (typeof body.approve !== 'boolean') error(400, 'approve must be a boolean');
	const result = decideCandidate(params.id, body.approve, { userId: user.id });
	if (!result) error(404, 'Candidate not found or already decided');
	emitEvent({
		userId: user.id,
		task: 'memory',
		type: 'job',
		name: `skill-candidate.${body.approve ? 'approve' : 'reject'} ${result.name}`,
		status: 'ok'
	});
	return json(result);
};
