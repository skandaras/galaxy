import { randomUUID } from 'node:crypto';
import { db } from '$lib/server/db';
import { usageLog } from '$lib/server/db/schema';
import type { ModelChoice } from '$lib/server/providers/registry';
import type { Usage } from '$lib/server/providers/types';

/** Just enough of a model row to price a call. */
export interface Pricing {
	promptCostPerMTok: number | null;
	completionCostPerMTok: number | null;
}

/**
 * What one call cost, in USD, or null when the model carries no prices.
 *
 * List price minus whatever the gateway says caching saved. That discount is
 * *signed*: negative on the turn that writes the cache, because a write costs
 * more than plain input, and positive on the later reads — hence the clamp at
 * zero rather than trusting the subtraction.
 */
export function costOf(model: Pricing | null | undefined, usage: Usage | null): number | null {
	if (!usage || !model) return null;
	if (model.promptCostPerMTok == null || model.completionCostPerMTok == null) return null;
	const list =
		(usage.promptTokens * model.promptCostPerMTok +
			usage.completionTokens * model.completionCostPerMTok) /
		1_000_000;
	return Math.max(0, list - (usage.cacheDiscountUsd ?? 0));
}

export interface UsageEntry {
	task: string;
	/**
	 * The model the call was made against. Priced from its row — passing the
	 * choice rather than a bare model key is the whole point: this used to take
	 * a string, could therefore not price anything, and wrote `costUsd: null`
	 * for every background agent while the budget cap summed that column.
	 */
	choice: ModelChoice | null;
	/** Only needed when `choice` is null — a failure that never resolved a model. */
	modelKey?: string;
	usage: Usage | null;
	status: 'ok' | 'error';
	userId?: string | null;
	/**
	 * The conversation, where there is one and it is persisted. A hidden chat
	 * spends real money and must be counted, but its id must not survive here:
	 * id, timing and cost together make the conversation reconstructable.
	 */
	chatId?: string | null;
}

/**
 * Record one model call against a task.
 *
 * Every model call in the platform goes through here — the agent loop, deep
 * research, and the background agents (memory, skill optimiser, ux-audit,
 * alignment, run-summary, chat-title, cortex-groom, sub-agents) alike. They all
 * spend money, and `getBudgetStatus` sums `cost_usd`, so anything that reaches
 * a provider without reaching this function is spend the cap cannot see.
 */
export function logUsage(entry: UsageEntry): void {
	const { usage } = entry;
	db.insert(usageLog)
		.values({
			id: randomUUID(),
			ts: new Date(),
			userId: entry.userId ?? null,
			chatId: entry.chatId ?? null,
			task: entry.task,
			modelKey: entry.choice?.model.modelKey ?? entry.modelKey ?? 'unknown',
			promptTokens: usage?.promptTokens ?? 0,
			completionTokens: usage?.completionTokens ?? 0,
			cachedPromptTokens: usage?.cachedPromptTokens ?? 0,
			// Part of completionTokens, not additional to it. Logged separately
			// because "wrote a lot" and "deliberated a lot" are different problems
			// with the same total, and only the second is usually a fault.
			reasoningTokens: usage?.reasoningTokens ?? 0,
			costUsd: costOf(entry.choice?.model, usage),
			status: entry.status
		})
		.run();
}
