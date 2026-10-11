import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/api';
import { decideCandidate } from '$lib/server/skills';
import { emitEvent } from '$lib/server/engine/events';

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	const admin = requireAdmin(locals);
	const body = await request.json().catch(() => ({}));
	if (body.action !== 'approve' && body.action !== 'reject') {
		error(400, 'action must be approve or reject');
	}
	const result = decideCandidate(params.id, body.action === 'approve');
	if (!result) error(404, 'Candidate not found or already decided');
	emitEvent({
		userId: admin.id,
		task: 'profile-learn',
		type: 'admin',
		name: `skill-candidate.${body.action} ${result.name}`,
		status: 'ok'
	});
	return json(result);
};
