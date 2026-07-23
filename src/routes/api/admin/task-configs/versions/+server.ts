import { error, json } from '@sveltejs/kit';
import { desc, eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/api';
import { db } from '$lib/server/db';
import { taskPromptVersions, CORE_TASKS, type CoreTask } from '$lib/server/db/schema';

export const GET: RequestHandler = ({ locals, url }) => {
	requireAdmin(locals);
	const task = url.searchParams.get('task') as CoreTask;
	if (!CORE_TASKS.includes(task)) error(400, `Unknown task: ${task}`);
	return json(
		db
			.select()
			.from(taskPromptVersions)
			.where(eq(taskPromptVersions.task, task))
			.orderBy(desc(taskPromptVersions.createdAt))
			.limit(50)
			.all()
	);
};
