import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireCoder } from '$lib/server/api';
import { getSession } from '$lib/server/engine/coding/session';
import { openPullRequest } from '$lib/server/engine/coding/pull-request';
import { emitEvent } from '$lib/server/engine/events';

/**
 * Open the session's pull request from the UI. The agent has a tool for this
 * too; the button exists because opening the PR is a decision a person makes
 * about finished work, and having to ask an agent to do it is a round-trip and
 * a model call for something that is one API call.
 */
export const POST: RequestHandler = async ({ locals, params, request }) => {
	const user = requireCoder(locals);
	const session = getSession(params.id, user.id);
	if (!session) error(404, 'Session not found');

	const body = await request.json().catch(() => ({}));
	const title =
		typeof body.title === 'string' && body.title.trim()
			? body.title.trim()
			: `${session.repoName}: work from a Galaxy coding session`;

	try {
		const pr = await openPullRequest(session, {
			title,
			body: typeof body.body === 'string' ? body.body : undefined
		});
		emitEvent({
			userId: user.id,
			chatId: session.chatId,
			task: 'coding',
			type: 'job',
			name: 'session.pull-request',
			status: 'ok',
			detail: { repo: session.repoName, number: pr.number, existing: pr.existing }
		});
		return json(pr);
	} catch (err) {
		const message = String(err instanceof Error ? err.message : err);
		emitEvent({
			userId: user.id,
			chatId: session.chatId,
			task: 'coding',
			type: 'job',
			name: 'session.pull-request',
			status: 'error',
			detail: { repo: session.repoName, error: message }
		});
		error(502, message);
	}
};
