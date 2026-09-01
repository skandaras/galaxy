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
	if (body.cacheMode === 'auto' || body.cacheMode === 'explicit' || body.cacheMode === 'none')
		patch.cacheMode = body.cacheMode;
	// No 'off'. Models with mandatory reasoning reject a request that tries to
	// disable it outright, so an off switch would be a setting that breaks some
	// models — 'low' is the floor. `auto` honours whatever the calling job asks
	// for, which is how the structured-output jobs get low effort without an
	// admin needing to know they exist.
	if (['auto', 'low', 'medium', 'high'].includes(body.reasoningMode))
		patch.reasoningMode = body.reasoningMode;
	if (Object.keys(patch).length) {
		db.update(models).set(patch).where(eq(models.id, row.id)).run();
	}
	return json({ ok: true });
};
