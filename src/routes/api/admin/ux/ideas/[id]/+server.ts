import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/api';
import { decideUxIdea } from '$lib/server/engine/ux-audit';
import { emitEvent } from '$lib/server/engine/events';

/**
 * Dismiss an idea. Both actions close it; nothing in the platform reacts to
 * either beyond recording the decision, which is the point — the backlog is
 * somewhere to think, not a queue that builds things.
 */
export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	const admin = requireAdmin(locals);
	const body = await request.json().catch(() => ({}));
	if (body.action !== 'actioned' && body.action !== 'discard') {
		error(400, 'action must be actioned or discard');
	}
	const result = decideUxIdea(params.id, body.action);
	if (!result) error(404, 'Idea not found or already decided');
	emitEvent({
		userId: admin.id,
		task: 'ux-audit',
		type: 'admin',
		name: `ux-idea.${result.status} ${result.title}`,
		status: 'ok'
	});
	return json({
		...result,
		createdAt: result.createdAt.getTime(),
		decidedAt: result.decidedAt?.getTime() ?? null
	});
};
