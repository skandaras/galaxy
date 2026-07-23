import { error, json } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/api';
import { db } from '$lib/server/db';
import { models } from '$lib/server/db/schema';

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	requireAdmin(locals);
	const row = db.select().from(models).where(eq(models.id, params.id)).get();
	if (!row) error(404, 'Model not found');
	const body = await request.json().catch(() => ({}));

	const patch: Partial<typeof models.$inferInsert> = {};
	if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
	if (typeof body.displayName === 'string' && body.displayName.trim())
		patch.displayName = body.displayName.trim();
	if (Object.keys(patch).length) {
		db.update(models).set(patch).where(eq(models.id, row.id)).run();
	}
	return json({ ok: true });
};
