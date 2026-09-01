import type { ReasoningEffort } from './types';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { models, providers } from '$lib/server/db/schema';
import { decryptSecret } from '$lib/server/crypto';
import { createOpenAiCompatAdapter } from './openai-compatible';
import type { ProviderAdapter } from './types';

export type ProviderRow = typeof providers.$inferSelect;
export type ModelRow = typeof models.$inferSelect;

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

export function adapterFor(provider: ProviderRow): ProviderAdapter {
	const apiKey = provider.apiKeyEnc ? decryptSecret(provider.apiKeyEnc) : undefined;
	return createOpenAiCompatAdapter({
		baseUrl: provider.baseUrl,
		apiKey,
		...(provider.kind === 'openrouter'
			? { extraHeaders: { 'HTTP-Referer': 'https://github.com/skandaras/galaxy', 'X-Title': 'Galaxy' } }
			: {})
	});
}

export interface ModelChoice {
	model: ModelRow;
	provider: ProviderRow;
	adapter: ProviderAdapter;
}

export function resolveModel(modelId: string): ModelChoice | null {
	const model = db.select().from(models).where(eq(models.id, modelId)).get();
	if (!model || !model.enabled) return null;
	const provider = db.select().from(providers).where(eq(providers.id, model.providerId)).get();
	if (!provider || !provider.enabled) return null;
	return { model, provider, adapter: adapterFor(provider) };
}

/**
 * How hard this model should think on this call, or nothing at all.
 *
 * The one place three different answers are combined, so no call site has to
 * know the rules:
 *
 * - the **job** says what it needs. Anything that reads material it was given
 *   and emits JSON or a short label wants `'low'`: extended deliberation buys
 *   nothing there and costs everything, because reasoning tokens are output
 *   tokens and output tokens are the wall clock.
 * - the **model** says whether the field may be sent at all. An endpoint that
 *   has never heard of it is entitled to reject the whole request, which is why
 *   `supportsReasoning` is read from the provider's listing rather than guessed
 *   — the same gate `supportsTools` puts on `tools` in loop.ts.
 * - the **admin** may override either way on the model row.
 *
 * The failure this exists to stop was invisible for three rounds: a groom call
 * capped at 4,096 tokens wrote 13,851 and was not truncated, because
 * `max_tokens` does not govern reasoning. Roughly four hundred of those tokens
 * were the answer. There was no way to ask for less, so every fix moved a
 * number that could not help.
 */
export function reasoningFor(
	choice: ModelChoice,
	want: ReasoningEffort | undefined
): ReasoningEffort | undefined {
	if (!choice.model.supportsReasoning) return undefined;
	const mode = choice.model.reasoningMode;
	return mode === 'auto' ? want : mode;
}

export interface ModelListing {
	id: string;
	displayName: string;
	modelKey: string;
	providerName: string;
	supportsTools: boolean;
	supportsVision: boolean;
	supportsImageOutput: boolean;
	supportsReasoning: boolean;
	contextWindow: number | null;
}

export function listEnabledModels(): ModelListing[] {
	const providerRows = new Map(
		db.select().from(providers).where(eq(providers.enabled, true)).all().map((p) => [p.id, p])
	);
	return db
		.select()
		.from(models)
		.where(eq(models.enabled, true))
		.all()
		.filter((m) => providerRows.has(m.providerId))
		.map((m) => ({
			id: m.id,
			displayName: m.displayName,
			modelKey: m.modelKey,
			providerName: providerRows.get(m.providerId)!.name,
			supportsTools: m.supportsTools,
			supportsVision: m.supportsVision,
			supportsImageOutput: m.supportsImageOutput,
			supportsReasoning: m.supportsReasoning,
			contextWindow: m.contextWindow
		}))
		.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/** Sync a provider's model list into the registry (upsert by model key). */
export async function syncProviderModels(provider: ProviderRow): Promise<number> {
	const remote = await adapterFor(provider).listModels(AbortSignal.timeout(30_000));
	const existing = new Map(
		db.select().from(models).where(eq(models.providerId, provider.id)).all().map((m) => [
			m.modelKey,
			m
		])
	);
	let count = 0;
	for (const rm of remote) {
		const prev = existing.get(rm.key);
		if (prev) {
			db.update(models)
				.set({
					displayName: rm.displayName,
					contextWindow: rm.contextWindow,
					supportsTools: rm.supportsTools,
					supportsVision: rm.supportsVision,
					// Capabilities the provider reports, so a re-sync corrects them —
					// unlike cacheMode, reasoningMode and enabled below, which an
					// admin owns.
					supportsImageOutput: rm.supportsImageOutput,
					supportsReasoning: rm.supportsReasoning,
					promptCostPerMTok: rm.promptCostPerMTok,
					completionCostPerMTok: rm.completionCostPerMTok
				})
				.where(eq(models.id, prev.id))
				.run();
		} else {
			db.insert(models)
				.values({
					id: crypto.randomUUID(),
					providerId: provider.id,
					modelKey: rm.key,
					displayName: rm.displayName,
					contextWindow: rm.contextWindow,
					supportsTools: rm.supportsTools,
					supportsVision: rm.supportsVision,
					supportsImageOutput: rm.supportsImageOutput,
					supportsReasoning: rm.supportsReasoning,
					promptCostPerMTok: rm.promptCostPerMTok,
					completionCostPerMTok: rm.completionCostPerMTok,
					// Both of these are starting points an admin then owns, which is
					// why neither appears in the update branch above: a re-sync must
					// not undo a decision someone made in the UI.
					cacheMode: rm.cacheMode,
					// Aggregators list hundreds of models; imports start disabled
					// and are switched on per-model in admin.
					enabled: false
				})
				.run();
		}
		count++;
	}
	return count;
}
