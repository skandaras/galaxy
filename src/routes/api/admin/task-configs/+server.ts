import { error, json } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/api';
import { db } from '$lib/server/db';
import {
	taskConfigs,
	taskPromptVersions,
	CORE_TASKS,
	type CoreTask
} from '$lib/server/db/schema';
import { emitEvent } from '$lib/server/engine/events';

export const GET: RequestHandler = ({ locals }) => {
	requireAdmin(locals);
	return json(db.select().from(taskConfigs).all());
};

export const PUT: RequestHandler = async ({ locals, request }) => {
	const admin = requireAdmin(locals);
	const body = await request.json().catch(() => ({}));
	const task = body.task as CoreTask;
	if (!CORE_TASKS.includes(task)) error(400, `Unknown task: ${body.task}`);
	const current = db.select().from(taskConfigs).where(eq(taskConfigs.task, task)).get();

	const patch: Partial<typeof taskConfigs.$inferInsert> = {};
	if (typeof body.systemPrompt === 'string' && body.systemPrompt !== current?.systemPrompt) {
		patch.systemPrompt = body.systemPrompt;
		db.insert(taskPromptVersions)
			.values({
				id: randomUUID(),
				task,
				systemPrompt: body.systemPrompt,
				author: admin.username,
				createdAt: new Date()
			})
			.run();
	}
	if ('primaryModelId' in body) patch.primaryModelId = body.primaryModelId || null;
	if ('backupModelId' in body) patch.backupModelId = body.backupModelId || null;
	if ('options' in body) patch.options = body.options ?? null;

	if (Object.keys(patch).length) {
		db.update(taskConfigs).set(patch).where(eq(taskConfigs.task, task)).run();
		emitEvent({
			userId: admin.id,
			task,
			type: 'admin',
			name: 'task-config.update',
			status: 'ok',
			detail: { fields: Object.keys(patch) }
		});
	}
	return json({ ok: true });
};
