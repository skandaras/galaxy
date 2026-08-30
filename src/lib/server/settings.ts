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
	/**
	 * Results asked of the provider, and shown, per query.
	 *
	 * Free: every provider bills the request, not the row. Brave returns up to
	 * 20 for the same call, and SearXNG and DuckDuckGo have theirs parsed and
	 * discarded — a low number here buys nothing and only narrows what the model
	 * and the reader get to see. What it does cost is context, so the snippet
	 * shrinks as this grows (see renderSnippetChars in tools/web-search).
	 */
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
	/**
	 * Which round of default changes this row has already been brought up to.
	 *
	 * A stored row wins over `DEFAULT_WEB_SEARCH` on every read, which is right
	 * for a number someone chose and wrong for one that is merely the default
	 * they were shown years ago — so raising a default here does nothing for any
	 * install that has ever pressed Save. This is how a change can reach those
	 * installs once, and only once: `migrateWebSearchSettings` moves a value only
	 * while it still equals the default it is replacing, then stamps this. An
	 * admin who later chooses that same value keeps it, because the stamp is
	 * already set.
	 */
	settingsVersion?: number;
}

/**
 * Bump when a default here changes in a way existing installs should inherit,
 * and add the corresponding step to `migrateWebSearchSettings`.
 */
export const WEB_SEARCH_SETTINGS_VERSION = 1;

export const DEFAULT_WEB_SEARCH: WebSearchSettings = {
	provider: 'none',
	fallbackProvider: 'none',
	maxResults: 20,
	timeoutMs: 10_000,
	maxSearchesPerTurn: 6,
	defaultLanguage: '',
	settingsVersion: WEB_SEARCH_SETTINGS_VERSION
};

/**
 * The stored web-search settings, filled out to a whole object.
 *
 * `getSetting` hands back the stored JSON untouched, so a row written before a
 * field existed leaves that field `undefined` in the engine — and `undefined`
 * is not harmless here: `parseDuckDuckGoHtml` stops at `results.length < max`,
 * which is false immediately, so an absent `maxResults` returned no results at
 * all. The admin API has always filled its own reads (`fill` in
 * api/admin/settings); this is the same guarantee for everything else.
 */
export function webSearchSettings(): WebSearchSettings {
	return { ...DEFAULT_WEB_SEARCH, ...getSetting<Partial<WebSearchSettings>>('websearch', {}) };
}

/**
 * Raise a stored row to the current defaults, once.
 *
 * Only values still equal to the default they are replacing move: someone who
 * deliberately set 12 results keeps 12. Returns null when there is nothing to
 * do, so a boot that changes nothing writes nothing.
 */
export function migrateWebSearchSettings(
	stored: Partial<WebSearchSettings> | null
): WebSearchSettings | null {
	// No row at all is not a migration — the defaults already apply.
	if (!stored || !Object.keys(stored).length) return null;
	const from = Number(stored.settingsVersion ?? 0);
	if (from >= WEB_SEARCH_SETTINGS_VERSION) return null;

	const next: WebSearchSettings = { ...DEFAULT_WEB_SEARCH, ...stored };
	if (from < 1) {
		// v1 — the search net widened. Providers bill the request, not the row,
		// so five was never a saving; and one more search per turn is what makes
		// looking, then narrowing, possible.
		if (stored.maxResults === 5) next.maxResults = 20;
		if (stored.maxSearchesPerTurn === 4) next.maxSearchesPerTurn = 6;
	}
	next.settingsVersion = WEB_SEARCH_SETTINGS_VERSION;
	return next;
}

/**
 * Clamp every numeric field, for the same reason `normaliseResearchSettings`
 * does: the form's `min`/`max` attributes are not validation, and a raw PUT
 * ignores them entirely.
 */
export function normaliseWebSearchSettings(raw: Record<string, unknown>): WebSearchSettings {
	const num = (v: unknown, fallback: number, min: number, max: number) => {
		const n = Number(v);
		return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
	};
	const merged = { ...DEFAULT_WEB_SEARCH, ...raw } as WebSearchSettings;
	return {
		...merged,
		maxResults: num(raw.maxResults, DEFAULT_WEB_SEARCH.maxResults, 1, 20),
		maxSearchesPerTurn: num(raw.maxSearchesPerTurn, DEFAULT_WEB_SEARCH.maxSearchesPerTurn, 1, 20),
		timeoutMs: num(raw.timeoutMs, DEFAULT_WEB_SEARCH.timeoutMs, 1_000, 120_000),
		// An admin who has been through the form has seen the current defaults,
		// so a save is itself the migration for anything still outstanding.
		settingsVersion: WEB_SEARCH_SETTINGS_VERSION
	};
}

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
	/** See the note on `WebSearchSettings.settingsVersion`. */
	settingsVersion?: number;
}

/**
 * Bump when a default here changes in a way existing installs should inherit,
 * and add the corresponding step to `migrateResearchSettings`.
 */
export const RESEARCH_SETTINGS_VERSION = 1;

export const DEFAULT_RESEARCH: ResearchSettings = {
	provider: 'inherit',
	maxQueries: 4,
	maxPages: 10,
	maxTokens: 2048,
	timeoutMs: 20_000,
	maxRounds: 4,
	// 4 rounds × 4 queries, so exhaustive effort is bounded by the round count
	// rather than tripping the run cap halfway through.
	maxSearchesPerRun: 16,
	modelTriage: false,
	extraLanguages: '',
	settingsVersion: RESEARCH_SETTINGS_VERSION
};

/** The stored research settings, filled out. Same reasoning as `webSearchSettings`. */
export function researchSettings(): ResearchSettings {
	return { ...DEFAULT_RESEARCH, ...getSetting<Partial<ResearchSettings>>('research', {}) };
}

/**
 * Raise a stored research row to the current defaults, once.
 *
 * Same contract as `migrateWebSearchSettings`: only a value still equal to the
 * default it replaces moves, and the stamp means it happens once.
 */
export function migrateResearchSettings(
	stored: Partial<ResearchSettings> | null
): ResearchSettings | null {
	if (!stored || !Object.keys(stored).length) return null;
	const from = Number(stored.settingsVersion ?? 0);
	if (from >= RESEARCH_SETTINGS_VERSION) return null;

	const next = normaliseResearchSettings(stored as Record<string, unknown>);
	if (from < 1) {
		// v1 — the search net widened to twenty results a query, which made six
		// pages a round the narrow part of the pipeline rather than a sensible
		// ceiling on it.
		if (stored.maxPages === 6) next.maxPages = 10;
	}
	next.settingsVersion = RESEARCH_SETTINGS_VERSION;
	return next;
}

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
		extraLanguages: typeof raw.extraLanguages === 'string' ? raw.extraLanguages : '',
		// An admin who has been through the form has seen the current defaults, so
		// a save is itself the migration for anything still outstanding.
		settingsVersion: RESEARCH_SETTINGS_VERSION
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

export interface AlignmentSettings {
	/**
	 * Platform-level kill switch for the whole feature. Each user opts in
	 * separately (`alignment.userEnabled`, default false) — this only decides
	 * whether they are allowed to.
	 */
	enabled: boolean;
	/** 168 = weekly. How often the synthesis letter is written, per user. */
	synthesisIntervalHours: number;
	/**
	 * Assessments the synthesis reads. It reads assessments rather than the
	 * entries themselves, so this is cheap — but a letter drawing on forty of
	 * them says less than one drawing on twelve.
	 */
	synthesisMaxAssessments: number;
	/**
	 * Entries one re-assessment run may re-judge after a constitution edit.
	 * Each is a model call, so this is the thing standing between a reworded
	 * value and an unbounded bill.
	 */
	maxReassessPerRun: number;
}

/**
 * Per-user opt-in, scoped to the user id. Default false: this is the one feature
 * in the platform nobody should find themselves already using.
 */
export const ALIGNMENT_ENABLED_KEY = 'alignment.userEnabled';

export const DEFAULT_ALIGNMENT: AlignmentSettings = {
	enabled: true,
	synthesisIntervalHours: 168,
	synthesisMaxAssessments: 12,
	maxReassessPerRun: 10
};

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
	/**
	 * Days of Cortex change history to keep.
	 *
	 * The log exists so automatic changes can be checked and undone, and both of
	 * those are things you do soon after they happen. A `before` snapshot is a
	 * whole node, so at a thousand concepts and a weekly groomer this is the
	 * fastest-growing thing Cortex owns. 0 disables pruning.
	 */
	cortexChangeDays: number;
}

export const DEFAULT_RETENTION: RetentionSettings = {
	eventDays: 60,
	usageDays: 400,
	uxIdeaDays: 14,
	cortexChangeDays: 90
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

export interface CortexSettings {
	/**
	 * Whether agents may write to the lattice, or only read it.
	 *
	 * On, now that the thing it was waiting for exists. It shipped off because an
	 * agent free to mint concepts produces near-duplicates — "music discovery",
	 * "discovering music", "music curation" — faster than anyone merges them,
	 * and there was no groomer. There is now: duplicate detection is
	 * deterministic and runs every pass, merges are proposals a person accepts,
	 * and since areas became reviewed-only an agent cannot file a concept at all.
	 *
	 * So the most an unreviewed write can do is add an unfiled concept with
	 * connections, which is the conservative end of this design rather than a
	 * hole in it.
	 */
	agentWrites: boolean;
	/**
	 * Whether this instance may look for the same concept in two people's
	 * lattices and offer to note the overlap.
	 *
	 * Off by default and opted into per user, because even the *proposal*
	 * discloses to one person that another holds a node by a similar name. See
	 * docs/CORTEX.md — kinship is a note, never an edge, and activation never
	 * traverses it.
	 */
	kinship: boolean;
	/**
	 * Nodes one person may own. Not a scaling limit — SQLite is nowhere near
	 * troubled at this size — but a lattice past a few thousand concepts has
	 * stopped being a memory and started being a landfill, and the cap is where
	 * that conversation happens.
	 */
	maxNodesPerUser: number;
	/**
	 * Whether connections strengthen when a reply actually uses them, and erode
	 * when nothing does.
	 *
	 * On. The alternative is a lattice whose weights are whatever somebody
	 * guessed on the day the concept was written, which never gets better and
	 * never gets worse — and the whole bet of a weighted mesh is that use is a
	 * better judge of a connection than a first estimate was.
	 *
	 * Off, `effectiveWeight` still adds a stored delta (so nothing already
	 * learned is thrown away), but nothing new moves and nothing decays.
	 */
	learning: boolean;
	/**
	 * Days a connection may sit at the erosion floor, untouched by any
	 * traversal, before the groomer suggests removing it.
	 *
	 * Long by design. This is the one place learning is allowed to propose
	 * destroying something, and a connection nobody has needed for two months is
	 * a much safer thing to raise than one nobody needed for a fortnight.
	 */
	staleDays: number;
}

export interface CortexGroomSettings {
	enabled: boolean;
	intervalHours: number;
	/** Proposals one run may raise, so a first pass cannot bury the review list. */
	maxProposalsPerRun: number;
}

export const DEFAULT_CORTEX_GROOM: CortexGroomSettings = {
	enabled: false,
	// Daily rather than weekly. The scheduled pass only reads what is new, and
	// skips the model entirely when nothing is, so a quiet day costs nothing —
	// which is what makes a short cadence affordable at all.
	intervalHours: 24,
	maxProposalsPerRun: 10
};

export const DEFAULT_CORTEX: CortexSettings = {
	agentWrites: true,
	kinship: false,
	maxNodesPerUser: 2000,
	learning: true,
	staleDays: 60
};
