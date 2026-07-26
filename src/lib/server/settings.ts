import { and, eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { settings } from '$lib/server/db/schema';

export const GLOBAL_SCOPE = 'global';

export function getSetting<T>(key: string, fallback: T, scope = GLOBAL_SCOPE): T {
	const row = db
		.select()
		.from(settings)
		.where(and(eq(settings.scope, scope), eq(settings.key, key)))
		.get();
	if (!row) return fallback;
	return row.value as T;
}

export function setSetting(key: string, value: unknown, scope = GLOBAL_SCOPE): void {
	db.insert(settings)
		.values({ scope, key, value, updatedAt: new Date() })
		.onConflictDoUpdate({
			target: [settings.scope, settings.key],
			set: { value, updatedAt: new Date() }
		})
		.run();
}

export type SearchProvider = 'duckduckgo' | 'brave' | 'tavily' | 'searxng' | 'none';

export interface WebSearchSettings {
	provider: SearchProvider;
	/**
	 * Tried only when the primary *fails* (blocked/unreachable/unparseable) —
	 * never when it legitimately returns zero results.
	 */
	fallbackProvider?: SearchProvider;
	/** AES-encrypted API key (see $lib/server/crypto); set via admin settings. */
	apiKeyEnc?: string;
	baseUrl?: string; // searxng instance
	maxResults: number;
	timeoutMs: number;
}

export const DEFAULT_WEB_SEARCH: WebSearchSettings = {
	provider: 'none',
	fallbackProvider: 'none',
	maxResults: 5,
	timeoutMs: 10_000
};

export interface GithubSettings {
	/** AES-encrypted personal access token. */
	tokenEnc?: string;
}

export interface ResearchSettings {
	/**
	 * 'inherit' uses the web-search provider; the others override it for
	 * research only ('searxng' additionally needs baseUrl).
	 */
	provider: 'inherit' | 'duckduckgo' | 'searxng';
	baseUrl?: string;
	maxQueries: number;
	maxPages: number;
	maxTokens: number;
	timeoutMs: number;
	iterationCap: number;
}

export const DEFAULT_RESEARCH: ResearchSettings = {
	provider: 'inherit',
	maxQueries: 4,
	maxPages: 6,
	maxTokens: 2048,
	timeoutMs: 20_000,
	iterationCap: 1
};

export interface BudgetSettings {
	enabled: boolean;
	limitUsd: number;
	period: 'day' | 'week' | 'month';
}

export const DEFAULT_BUDGET: BudgetSettings = { enabled: false, limitUsd: 25, period: 'month' };

export interface MemorySettings {
	enabled: boolean;
	intervalHours: number;
}

export const DEFAULT_MEMORY: MemorySettings = { enabled: true, intervalHours: 12 };

export interface CompactionSettings {
	/** Compact when estimated context exceeds this share of the model's window. */
	ratio: number;
	/** Always keep this many recent messages verbatim. */
	keepRecent: number;
}

export const DEFAULT_COMPACTION: CompactionSettings = { ratio: 0.7, keepRecent: 8 };
