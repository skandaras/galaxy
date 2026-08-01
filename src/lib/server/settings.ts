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

/** Remove a setting entirely. `value` is NOT NULL, so writing null is not an option. */
export function deleteSetting(key: string, scope = GLOBAL_SCOPE): void {
	db.delete(settings)
		.where(and(eq(settings.scope, scope), eq(settings.key, key)))
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
	/**
	 * Live searches one chat turn may make. Repeats of a query already run in
	 * the same turn are served from memory and don't count. Without a cap a
	 * model that isn't finding what it wants will keep rephrasing.
	 */
	maxSearchesPerTurn: number;
}

export const DEFAULT_WEB_SEARCH: WebSearchSettings = {
	provider: 'none',
	fallbackProvider: 'none',
	maxResults: 5,
	timeoutMs: 10_000,
	maxSearchesPerTurn: 4
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

export interface CodingSettings {
	/**
	 * Commit uncommitted work locally when a turn ends, so a turn cut short
	 * leaves something in the diff view and in `git log` instead of a workspace
	 * that only looks untouched. Never pushes.
	 */
	autoCheckpoint: boolean;
	/**
	 * Start another leg automatically when a turn runs out of steps with work
	 * still outstanding, rather than waiting to be told to continue.
	 */
	autoContinue: boolean;
	/** Hard ceiling on legs per request, including the first. */
	maxLegs: number;
}

export const DEFAULT_CODING: CodingSettings = {
	autoCheckpoint: true,
	autoContinue: true,
	maxLegs: 3
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

export interface UxAuditSettings {
	enabled: boolean;
	/** 168 = weekly. Global, not per user: the audit reviews the platform. */
	intervalHours: number;
	/**
	 * Ideas one run may file. A cap matters more here than elsewhere: an
	 * enthusiastic model can bury a genuinely good idea under a dozen
	 * restatements of the same one, and nobody skims a list of thirty.
	 */
	maxIdeasPerRun: number;
}

export const DEFAULT_UX_AUDIT: UxAuditSettings = {
	enabled: true,
	intervalHours: 168,
	maxIdeasPerRun: 8
};

export interface RetentionSettings {
	/**
	 * Days of Observatory history to keep. Events are the fastest-growing table
	 * (one row per model call, tool call and job) and are diagnostic, not
	 * financial — 0 disables pruning entirely.
	 */
	eventDays: number;
	/**
	 * Days of usage history to keep. Longer by default because this is what the
	 * budget cap and the usage dashboard read; the dashboard allows a 365-day
	 * window, so anything below that silently truncates its own charts.
	 */
	usageDays: number;
	/**
	 * Days to keep UX backlog ideas — **non-production instances only**.
	 *
	 * Prod never prunes: its record of what has been actioned or discarded is the
	 * entire mechanism that stops the audit re-proposing the same thing. A dev
	 * instance runs the audit to prove each release still works, so its list is
	 * throwaway, and letting it accumulate would suppress ideas on dev that
	 * nobody ever actually read. 0 disables pruning there too.
	 */
	uxIdeaDays: number;
}

export const DEFAULT_RETENTION: RetentionSettings = {
	eventDays: 60,
	usageDays: 400,
	uxIdeaDays: 14
};

export interface CompactionSettings {
	/** Compact when estimated context exceeds this share of the model's window. */
	ratio: number;
	/** Always keep this many recent messages verbatim. */
	keepRecent: number;
}

export const DEFAULT_COMPACTION: CompactionSettings = { ratio: 0.7, keepRecent: 8 };
