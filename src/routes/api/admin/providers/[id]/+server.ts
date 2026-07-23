import { error, json } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/api';
import { db } from '$lib/server/db';
import { models, providers } from '$lib/server/db/schema';
import { encryptSecret } from '$lib/server/crypto';

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	requireAdmin(locals);
	const row = db.select().from(providers).where(eq(providers.id, params.id)).get();
	if (!row) error(404, 'Provider not found');
	const body = await request.json().catch(() => ({}));

	const patch: Partial<typeof providers.$inferInsert> = {};
	if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim();
	if (typeof body.baseUrl === 'string' && body.baseUrl.trim())
		patch.baseUrl = body.baseUrl.trim().replace(/\/$/, '');
	if (typeof body.apiKey === 'string') {
		patch.apiKeyEnc = body.apiKey ? encryptSecret(body.apiKey) : null;
	}
	if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;

	if (Object.keys(patch).length) {
		db.update(providers).set(patch).where(eq(providers.id, row.id)).run();
	}
	return json({ ok: true });
};

export const DELETE: RequestHandler = ({ locals, params }) => {
	requireAdmin(locals);
	db.delete(models).where(eq(models.providerId, params.id)).run();
	db.delete(providers).where(eq(providers.id, params.id)).run();
	return json({ ok: true });
};
