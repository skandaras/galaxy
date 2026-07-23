import { error, json } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/api';
import { db } from '$lib/server/db';
import { providers } from '$lib/server/db/schema';
import { encryptSecret } from '$lib/server/crypto';
import { OPENROUTER_BASE_URL } from '$lib/server/providers/registry';
import { emitEvent } from '$lib/server/engine/events';

const masked = (p: typeof providers.$inferSelect) => ({
	id: p.id,
	kind: p.kind,
	name: p.name,
	baseUrl: p.baseUrl,
	hasKey: Boolean(p.apiKeyEnc),
	enabled: p.enabled,
	createdAt: p.createdAt.getTime()
});

export const GET: RequestHandler = ({ locals }) => {
	requireAdmin(locals);
	return json(db.select().from(providers).all().map(masked));
};

export const POST: RequestHandler = async ({ locals, request }) => {
	const admin = requireAdmin(locals);
	const body = await request.json().catch(() => ({}));
	const kind = body.kind === 'openrouter' ? 'openrouter' : 'openai-compatible';
	const baseUrl =
		typeof body.baseUrl === 'string' && body.baseUrl.trim()
			? body.baseUrl.trim().replace(/\/$/, '')
			: kind === 'openrouter'
				? OPENROUTER_BASE_URL
				: '';
	if (!baseUrl) error(400, 'baseUrl is required for openai-compatible providers');
	const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : kind;

	const row = {
		id: randomUUID(),
		kind: kind as 'openrouter' | 'openai-compatible',
		name,
		baseUrl,
		apiKeyEnc: typeof body.apiKey === 'string' && body.apiKey ? encryptSecret(body.apiKey) : null,
		enabled: true,
		createdAt: new Date()
	};
	db.insert(providers).values(row).run();
	emitEvent({
		userId: admin.id,
		type: 'admin',
		name: 'provider.create',
		status: 'ok',
		detail: { provider: name, kind }
	});
	return json(masked(row), { status: 201 });
};
