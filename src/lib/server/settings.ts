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
	/**
	 * BCP-47 code the search provider is biased towards when a call doesn't name
	 * one, e.g. 'de' or 'pt-br'. Empty means no constraint, which is the right
	 * default: the engines infer language from the query, and pinning one
	 * globally would quietly narrow every search on the platform.
	 */
	defaultLanguage?: string;
}

export const DEFAULT_WEB_SEARCH: WebSearchSettings = {
	provider: 'none',
	fallbackProvider: 'none',
	maxResults: 5,
	timeoutMs: 10_000,
	maxSearchesPerTurn: 4,
	defaultLanguage: ''
};

export interface FetchSettings {
	/** Per-request deadline for reading one address. */
	timeoutMs: number;
	/** Characters of a page handed to the model before it is clipped. */
	maxChars: number;
	/**
	 * Pages one turn may read. Repeats of an address already read in the same
	 * turn are served from memory and don't count.
	 */
	maxFetchesPerTurn: number;
}

export const DEFAULT_FETCH: FetchSettings = {
	timeoutMs: 15_000,
	maxChars: 20_000,
	maxFetchesPerTurn: 5
};

export interface GithubSettings {
	/** AES-encrypted personal access token. */
	tokenEnc?: string;
}

/** Hard ceiling on rounds, whatever an admin (or a raw API call) asks for. */
export const RESEARCH_ROUNDS_MAX = 8;

export interface ResearchSettings {
	/**
	 * 'inherit' uses the web-search provider; the others override it for
	 * research only ('searxng' additionally needs baseUrl).
	 */
	provider: 'inherit' | 'duckduckgo' | 'searxng';
	baseUrl?: string;
	/** Queries per round at full effort; lower efforts take a fraction. */
	maxQueries: number;
	/** Pages read per round at full effort, not per run. */
	maxPages: number;
	maxTokens: number;
	timeoutMs: number;
	/**
	 * Rounds of search → read → consolidate one run may take at `exhaustive`
	 * effort, including the first. 1 means a single pass with no consolidation.
	 *
	 * This is the ceiling; the per-request effort picks a fraction of it.
	 */
	maxRounds: number;
	/**
	 * @deprecated Pre-effort name, and it counted *extra* rounds rather than
	 * total: `maxRounds = iterationCap + 1`. Read only by
	 * `researchRoundCeiling`, so installs saved before the effort control keep
	 * the depth they configured. Never written back.
	 */
	iterationCap?: number;
	/**
	 * Searches one research run may make in total, across every round.
	 *
	 * The pipeline was bounded only by `maxQueries × rounds` falling out of the
	 * loop shape. Stating it means the ceiling is visible, adjustable, and
	 * demonstrably reset for each new request.
	 */
	maxSearchesPerRun: number;
	/**
	 * Let the model choose which search results to open, instead of taking the
	 * deduped, domain-diverse shortlist in order.
	 *
	 * Off by default. It adds a round-trip to the critical path of every round
	 * that qualifies, and its whole evidence base is titles and search snippets
	 * — text written by SEO teams to be picked. The deterministic triage is
	 * where the reliable win is, and it runs either way; turn this on and watch
	 * the `research.triage` events before deciding it earns its cost here.
	 */
	modelTriage?: boolean;
	/**
	 * Languages the planner is told to also search in, as a comma-separated list
	 * of BCP-47 codes. Empty leaves the choice to the model, which will use the
	 * question's own language.
	 */
	extraLanguages?: string;
}

export const DEFAULT_RESEARCH: ResearchSettings = {
	provider: 'inherit',
	maxQueries: 4,
	maxPages: 6,
	maxTokens: 2048,
	timeoutMs: 20_000,
	maxRounds: 4,
	// 4 rounds × 4 queries, so exhaustive effort is bounded by the round count
	// rather than tripping the run cap halfway through.
	maxSearchesPerRun: 16,
	modelTriage: false,
	extraLanguages: ''
};

/**
 * Total rounds allowed, honouring a legacy `iterationCap` row.
 *
 * The two keys do not mean the same thing — `iterationCap` counted rounds
 * *after* the first — so reading one as the other would quietly lengthen every
 * run on an install that had tuned it. The `+ 1` is the whole migration.
 */
export function researchRoundCeiling(cfg: Partial<ResearchSettings>): number {
	const explicit = Number(cfg.maxRounds);
	if (Number.isFinite(explicit) && explicit >= 1) {
		return Math.min(RESEARCH_ROUNDS_MAX, Math.floor(explicit));
	}
	const legacy = Number(cfg.iterationCap);
	if (Number.isFinite(legacy) && legacy >= 0) {
		return Math.min(RESEARCH_ROUNDS_MAX, Math.floor(legacy) + 1);
	}
	return DEFAULT_RESEARCH.maxRounds;
}

/**
 * Clamp every numeric field and fold the legacy key away for good.
 *
 * The admin route stores whatever it is handed, so the `min`/`max` attributes
 * on the settings form were the only thing keeping these in range — and a raw
 * PUT ignores those entirely. `iterationCap` is deliberately absent from the
 * result: once a row has been read or written through here it is gone.
 */
export function normaliseResearchSettings(raw: Record<string, unknown>): ResearchSettings {
	const num = (v: unknown, fallback: number, min: number, max: number) => {
		const n = Number(v);
		return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
	};
	const provider = String(raw.provider);
	return {
		provider: (['inherit', 'duckduckgo', 'searxng'] as const).includes(
			provider as ResearchSettings['provider']
		)
			? (provider as ResearchSettings['provider'])
			: 'inherit',
		...(typeof raw.baseUrl === 'string' ? { baseUrl: raw.baseUrl } : {}),
		maxQueries: num(raw.maxQueries, DEFAULT_RESEARCH.maxQueries, 1, 10),
		maxPages: num(raw.maxPages, DEFAULT_RESEARCH.maxPages, 1, 20),
		maxTokens: num(raw.maxTokens, DEFAULT_RESEARCH.maxTokens, 256, 200_000),
		timeoutMs: num(raw.timeoutMs, DEFAULT_RESEARCH.timeoutMs, 2_000, 120_000),
		maxRounds: researchRoundCeiling(raw as Partial<ResearchSettings>),
		maxSearchesPerRun: num(raw.maxSearchesPerRun, DEFAULT_RESEARCH.maxSearchesPerRun, 1, 40),
		modelTriage: raw.modelTriage === true,
		extraLanguages: typeof raw.extraLanguages === 'string' ? raw.extraLanguages : ''
	};
}

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

export interface BoardSettings {
	/**
	 * Boards one person may own. Not a scaling limit — a household runs out of
	 * attention long before SQLite runs out of rows — but it stops a runaway
	 * agent or a stuck button filling the picker with empty boards.
	 */
	maxBoardsPerUser: number;
	/**
	 * Whether agents may change cards, or only read them. Reading is what makes
	 * an agent aware of what you are doing; writing is what lets it tick things
	 * off, which not everyone wants on day one.
	 */
	agentWrites: boolean;
}

export const DEFAULT_BOARDS: BoardSettings = { maxBoardsPerUser: 20, agentWrites: true };
