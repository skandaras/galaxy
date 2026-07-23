import { json } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { db } from '$lib/server/db';
import { taskConfigs } from '$lib/server/db/schema';
import { listEnabledModels } from '$lib/server/providers/registry';

export const GET: RequestHandler = ({ locals }) => {
	requireUser(locals);
	const cfg = db.select().from(taskConfigs).where(eq(taskConfigs.task, 'chat')).get();
	return json({
		models: listEnabledModels(),
		defaultModelId: cfg?.primaryModelId ?? null
	});
};
