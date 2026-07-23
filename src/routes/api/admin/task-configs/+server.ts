import { error, json } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/api';
import { db } from '$lib/server/db';
import { taskConfigs, CORE_TASKS, type CoreTask } from '$lib/server/db/schema';

export const GET: RequestHandler = ({ locals }) => {
	requireAdmin(locals);
	return json(db.select().from(taskConfigs).all());
};

export const PUT: RequestHandler = async ({ locals, request }) => {
	requireAdmin(locals);
	const body = await request.json().catch(() => ({}));
	const task = body.task as CoreTask;
	if (!CORE_TASKS.includes(task)) error(400, `Unknown task: ${body.task}`);

	const patch: Partial<typeof taskConfigs.$inferInsert> = {};
	if (typeof body.systemPrompt === 'string') patch.systemPrompt = body.systemPrompt;
	if ('primaryModelId' in body) patch.primaryModelId = body.primaryModelId || null;
	if ('backupModelId' in body) patch.backupModelId = body.backupModelId || null;
	if ('options' in body) patch.options = body.options ?? null;

	db.update(taskConfigs).set(patch).where(eq(taskConfigs.task, task)).run();
	return json({ ok: true });
};
