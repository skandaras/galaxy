import { randomUUID } from 'node:crypto';
import { db } from '$lib/server/db';
import { usageLog } from '$lib/server/db/schema';

/**
 * Record one model call against a task. Background agents (memory, skill
 * optimiser, ux-audit) call this directly — they run outside the agent loop but
 * still spend money, and leaving them out would make the budget cap and the
 * usage dashboard quietly wrong.
 */
export function logUsage(
	task: string,
	modelKey: string,
	usage: {
		promptTokens: number;
		completionTokens: number;
		cachedPromptTokens?: number;
		reasoningTokens?: number;
	} | null,
	status: 'ok' | 'error',
	userId?: string
): void {
	db.insert(usageLog)
		.values({
			id: randomUUID(),
			ts: new Date(),
			userId: userId ?? null,
			chatId: null,
			task,
			modelKey,
			promptTokens: usage?.promptTokens ?? 0,
			completionTokens: usage?.completionTokens ?? 0,
			cachedPromptTokens: usage?.cachedPromptTokens ?? 0,
			// Part of completionTokens, not additional to it. Logged separately
			// because "wrote a lot" and "deliberated a lot" are different problems
			// with the same total, and only the second is usually a fault.
			reasoningTokens: usage?.reasoningTokens ?? 0,
			costUsd: null,
			status
		})
		.run();
}
