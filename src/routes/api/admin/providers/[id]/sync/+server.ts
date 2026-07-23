import { error, json } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/api';
import { db } from '$lib/server/db';
import { providers } from '$lib/server/db/schema';
import { syncProviderModels } from '$lib/server/providers/registry';
import { emitEvent } from '$lib/server/engine/events';

export const POST: RequestHandler = async ({ locals, params }) => {
	const admin = requireAdmin(locals);
	const row = db.select().from(providers).where(eq(providers.id, params.id)).get();
	if (!row) error(404, 'Provider not found');

	const started = Date.now();
	try {
		const count = await syncProviderModels(row);
		emitEvent({
			userId: admin.id,
			type: 'admin',
			name: 'provider.sync',
			status: 'ok',
			durationMs: Date.now() - started,
			detail: { provider: row.name, models: count }
		});
		return json({ synced: count });
	} catch (err) {
		emitEvent({
			userId: admin.id,
			type: 'admin',
			name: 'provider.sync',
			status: 'error',
			durationMs: Date.now() - started,
			detail: { provider: row.name, error: String(err) }
		});
		error(502, `Model sync failed: ${String(err)}`);
	}
};
