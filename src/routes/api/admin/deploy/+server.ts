import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { requireAdmin } from '$lib/server/api';
import { githubToken } from '$lib/server/engine/coding/workspace';
import { emitEvent } from '$lib/server/engine/events';

// Promote/rollback: dispatches the Promote workflow, which retags images in
// GHCR; prod follows the :stable tag. Before promoting, the dev instance's
// health is checked when DEV_HEALTH_URL is configured (the promotion gate).
export const POST: RequestHandler = async ({ locals, request }) => {
	const admin = requireAdmin(locals);
	const body = await request.json().catch(() => ({}));
	const action = body.action === 'rollback' ? 'rollback' : 'promote';

	const token = githubToken();
	if (!token) error(400, 'Set a GitHub token (with workflow scope) in Settings first');
	const repo = env.GITHUB_REPO || 'skandaras/galaxy';

	if (action === 'promote' && env.DEV_HEALTH_URL) {
		try {
			const health = await fetch(env.DEV_HEALTH_URL, { signal: AbortSignal.timeout(10_000) });
			const data = await health.json();
			if (!health.ok || data.status !== 'ok') throw new Error(`status ${health.status}`);
		} catch (err) {
			emitEvent({
				userId: admin.id,
				type: 'admin',
				name: 'deploy.promote',
				status: 'error',
				detail: { gate: 'dev healthz failed', error: String(err) }
			});
			error(409, `Promotion gate: dev instance is not healthy (${String(err)})`);
		}
	}

	const res = await fetch(
		`https://api.github.com/repos/${repo}/actions/workflows/promote.yml/dispatches`,
		{
			method: 'POST',
			headers: {
				authorization: `Bearer ${token}`,
				accept: 'application/vnd.github+json',
				'user-agent': 'galaxy'
			},
			body: JSON.stringify({ ref: env.PROMOTE_REF || 'main', inputs: { action } }),
			signal: AbortSignal.timeout(15_000)
		}
	);
	if (res.status !== 204) {
		const text = await res.text().catch(() => '');
		emitEvent({
			userId: admin.id,
			type: 'admin',
			name: `deploy.${action}`,
			status: 'error',
			detail: { status: res.status, error: text.slice(0, 300) }
		});
		error(502, `Workflow dispatch failed (${res.status}) — does the token have workflow scope?`);
	}

	emitEvent({ userId: admin.id, type: 'admin', name: `deploy.${action}`, status: 'ok' });
	return json({ dispatched: action });
};
