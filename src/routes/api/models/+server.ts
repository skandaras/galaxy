import { json } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { db } from '$lib/server/db';
import { taskConfigs } from '$lib/server/db/schema';
import { listEnabledModels } from '$lib/server/providers/registry';

export const GET: RequestHandler = ({ locals, url }) => {
	requireUser(locals);
	const task = url.searchParams.get('task') ?? 'chat';
	const cfg = db.select().from(taskConfigs).where(eq(taskConfigs.task, task)).get();
	return json({
		// Image-only models only for a picker that can use one: Admin's task list,
		// which offers them to `visual` alone.
		models: listEnabledModels({ includeImageOnly: url.searchParams.get('images') === '1' }),
		defaultModelId: cfg?.primaryModelId ?? null
	});
};
