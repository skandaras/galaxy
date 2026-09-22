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
import { taskPrompt } from '$lib/server/engine/engine';
import { DEFAULT_PROMPTS } from '$lib/server/engine/prompts';

/**
 * Every task, with the prompt it will actually run on and the default behind it.
 *
 * `systemPrompt` is resolved rather than read from the column of that name: the
 * column is a rollback copy and nothing else (see the schema). Sending
 * `defaultPrompt` too is what lets the editor offer "reset to default" without a
 * second endpoint, and lets it show whether a task is running on the owner's
 * text or on the shipped one.
 */
export const GET: RequestHandler = ({ locals }) => {
	requireAdmin(locals);
	return json(
		db
			.select()
			.from(taskConfigs)
			.all()
			.map((row) => ({
				...row,
				systemPrompt: taskPrompt(row.task),
				defaultPrompt: DEFAULT_PROMPTS[row.task] ?? '',
				overridden: row.promptOverride !== null
			}))
	);
};

export const PUT: RequestHandler = async ({ locals, request }) => {
	const admin = requireAdmin(locals);
	const body = await request.json().catch(() => ({}));
	const task = body.task as CoreTask;
	if (!CORE_TASKS.includes(task)) error(400, `Unknown task: ${body.task}`);

	const patch: Partial<typeof taskConfigs.$inferInsert> = {};
	// Saving text identical to the shipped default clears the override rather
	// than storing a copy of it. That is what makes "reset to default" a save
	// like any other, and it is also what keeps a task tracking the code: a
	// stored copy would freeze at today's wording, which is the whole failure
	// the override column exists to end.
	if (typeof body.systemPrompt === 'string' && body.systemPrompt !== taskPrompt(task)) {
		const isDefault = body.systemPrompt === (DEFAULT_PROMPTS[task] ?? '');
		patch.promptOverride = isDefault ? null : body.systemPrompt;
		// Kept in step for a rollback to the previous image, which reads it. See
		// the column's comment in the schema.
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
