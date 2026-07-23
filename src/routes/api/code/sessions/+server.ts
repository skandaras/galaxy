import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { createSession } from '$lib/server/engine/coding/session';
import { emitEvent } from '$lib/server/engine/events';

export const POST: RequestHandler = async ({ locals, request }) => {
	const user = requireUser(locals);
	const body = await request.json().catch(() => ({}));
	const repoUrl = typeof body.repoUrl === 'string' ? body.repoUrl.trim() : '';
	if (!repoUrl) error(400, 'repoUrl is required');
	const repoName =
		typeof body.repoName === 'string' && body.repoName.trim()
			? body.repoName.trim()
			: repoUrl.replace(/\.git$/, '').split('/').slice(-2).join('/');
	const mode = body.mode === 'implement' ? 'implement' : 'plan';

	try {
		const session = await createSession({ userId: user.id, repoUrl, repoName, mode });
		emitEvent({
			userId: user.id,
			chatId: session.chatId,
			task: 'coding',
			type: 'job',
			name: 'session.create',
			status: 'ok',
			detail: { repo: repoName, branch: session.workBranch }
		});
		return json(session, { status: 201 });
	} catch (err) {
		emitEvent({
			userId: user.id,
			task: 'coding',
			type: 'job',
			name: 'session.create',
			status: 'error',
			detail: { repo: repoName, error: String(err) }
		});
		error(502, String(err instanceof Error ? err.message : err));
	}
};
