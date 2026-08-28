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

export interface ModelListing {
	id: string;
	displayName: string;
	modelKey: string;
	providerName: string;
	supportsTools: boolean;
	supportsVision: boolean;
	supportsImageOutput: boolean;
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
					// A capability the provider reports, so a re-sync corrects it —
					// unlike cacheMode and enabled below, which an admin owns.
					supportsImageOutput: rm.supportsImageOutput,
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
