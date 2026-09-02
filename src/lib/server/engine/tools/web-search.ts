import type { SearchResultRow } from '$lib/run-timeline';
import type { ToolDef } from '$lib/server/providers/types';
import type { SearchProvider, WebSearchSettings } from '$lib/server/settings';
import { decryptSecret } from '$lib/server/crypto';
import { searchConcurrency, searchProviderGapMs, searchThrottledGapMs } from '../limits';
import type { LoopTool } from '../loop';

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

/** What actually happened, for the Observatory and the admin test button. */
export interface SearchOutcome {
	results: SearchResult[];
	provider: SearchProvider;
	/** Set when the primary failed and a fallback answered. */
	failedOver?: { from: SearchProvider; reason: string };
	/**
	 * Set when the provider answered but part of it was down — a SearXNG
	 * instance with some engines blocked, say. The results are real but thinner
	 * than they should be, and neither the model nor the reader should take
	 * them for the whole of what exists.
	 */
	degraded?: DegradedSearch;
	/** Language the search was asked to bias towards, if any. */
	language?: string;
	/**
	 * False when a language was asked for and the provider has no parameter for
	 * it. Not a failure — the query wording still does most of the work — but
	 * the model needs telling, or it reads thin results as the tool misbehaving.
	 */
	languageApplied?: boolean;
	/**
	 * The value the provider was actually given, which is not the tag that was
	 * asked for — Brave calls Chinese `zh-hans`. Logged because without it a
	 * rejected search says only which language was *wanted*, and the question in
	 * front of you is always which value was *sent*.
	 */
	languageSent?: string;
}

/**
 * Accept a BCP-47-ish language tag, or nothing.
 *
 * This value reaches a provider's query string, and it arrives from a model,
 * so the shape is allowlisted rather than escaped: two or three letters, with
 * an optional region subtag. Anything else becomes '' and the search simply
 * runs unconstrained, which is a better outcome than refusing the call.
 */
export function normaliseLanguage(raw: unknown): string {
	if (typeof raw !== 'string') return '';
	const v = raw.trim().toLowerCase().replace('_', '-');
	return /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/.test(v) ? v : '';
}

/**
 * DuckDuckGo's `kl` is a *region-language* pair, the opposite order from
 * BCP-47, and not always derivable from it: `en-gb` is `uk-en`, not `gb-en`.
 * Derive the regular ones and keep a short table for those that don't.
 */
const DDG_REGIONS: Record<string, string> = {
	en: 'us-en',
	'en-gb': 'uk-en',
	'en-us': 'us-en',
	'en-au': 'au-en',
	'en-ca': 'ca-en',
	'pt-br': 'br-pt',
	'zh-cn': 'cn-zh',
	'zh-tw': 'tw-zh',
	ja: 'jp-jp',
	ko: 'kr-kr',
	sv: 'se-sv',
	da: 'dk-da',
	el: 'gr-el',
	cs: 'cz-cs',
	uk: 'ua-uk',
	he: 'il-he',
	vi: 'vn-vi',
	zh: 'cn-zh'
};

export function ddgRegion(lang: string): string {
	if (!lang) return '';
	if (DDG_REGIONS[lang]) return DDG_REGIONS[lang];
	const [base, region] = lang.split('-');
	// `de-at` → `at-de`; bare `de` → `de-de`, which is DDG's own convention.
	return region ? `${region}-${base}` : `${base}-${base}`;
}

/**
 * Every value Brave's `search_lang` accepts.
 *
 * It is an allowlist, and it is not BCP-47: Chinese is `zh-hans`/`zh-hant` and
 * never bare `zh`, Japanese is `jp` rather than `ja`, and Portuguese exists only
 * as `pt-br`/`pt-pt`. Anything else comes back HTTP 422 with this list in the
 * body, so it is the allowlist here too — a tag that is not in it is one we must
 * not send.
 */
const BRAVE_LANGUAGES = new Set([
	'ar', 'eu', 'bn', 'bg', 'ca', 'zh-hans', 'zh-hant', 'hr', 'cs', 'da', 'nl',
	'en', 'en-gb', 'et', 'fi', 'fr', 'gl', 'de', 'el', 'gu', 'he', 'hi', 'hu',
	'is', 'it', 'jp', 'kn', 'ko', 'lv', 'lt', 'ms', 'ml', 'mr', 'nb', 'pl',
	'pt-br', 'pt-pt', 'pa', 'ro', 'ru', 'sr', 'sk', 'sl', 'es', 'sv', 'ta', 'te',
	'th', 'tr', 'uk', 'vi'
]);

/**
 * BCP-47 tags whose Brave equivalent is not derivable from them.
 *
 * The same shape as DDG_REGIONS above, for the same reason. Simplified Chinese
 * is the default reading of an untagged `zh` because it is the larger index;
 * `zh-tw` and `zh-hk` are the traditional-script regions.
 */
const BRAVE_LANGUAGE_ALIASES: Record<string, string> = {
	zh: 'zh-hans',
	'zh-cn': 'zh-hans',
	'zh-sg': 'zh-hans',
	'zh-tw': 'zh-hant',
	'zh-hk': 'zh-hant',
	'zh-mo': 'zh-hant',
	ja: 'jp',
	pt: 'pt-pt'
};

/**
 * What Brave should be asked for, or null when it has no way to express this.
 *
 * Deliberately no `country`: Brave's list already carries the regional variants
 * it supports, and splitting the tag to derive a market is what destroyed the
 * ones that were already valid — `pt-br` became `search_lang=pt&country=BR`,
 * and neither half is a value Brave takes.
 */
export function braveLanguage(lang: string): string | null {
	if (!lang) return null;
	const alias = BRAVE_LANGUAGE_ALIASES[lang];
	if (alias) return alias;
	if (BRAVE_LANGUAGES.has(lang)) return lang;
	// `de-at` has no Brave equivalent, but `de` does; a region we cannot express
	// is better dropped than sent.
	const base = lang.split('-')[0];
	return BRAVE_LANGUAGES.has(base) ? base : null;
}

/**
 * How a provider will read a list of language codes an admin has configured.
 *
 * The settings fields are free text, and their own placeholders suggested `ja`
 * and `pt-br` — two codes Brave does not take in that form. A code that quietly
 * does nothing is worse than one that is refused, because every search carrying
 * it comes back empty and is reported to the model as "nothing exists".
 */
export function languageSupport(
	provider: SearchProvider,
	codes: string
): { code: string; sentAs: string | null }[] {
	return codes
		.split(',')
		.map((raw) => normaliseLanguage(raw))
		.filter(Boolean)
		.map((code) => ({ code, sentAs: providerLanguage(provider, code) }));
}

/**
 * The Brave value nearest to a code it cannot take, for an error message.
 * Chinese and Japanese are the two anyone actually hits.
 */
export function braveAlternatives(code: string): string[] {
	const base = code.split('-')[0];
	return [...BRAVE_LANGUAGES].filter((v) => v.split('-')[0] === base || (base === 'ja' && v === 'jp'));
}

/**
 * The value a provider wants for this language, or null when it cannot honour
 * the tag at all.
 *
 * This replaced a per-provider boolean, which was the second half of the bug:
 * Brave answered `true` for every tag including the ones it rejects, so
 * `languageApplied` was reported true for a parameter that never took effect and
 * the one warning the system has was never raised.
 */
export function providerLanguage(provider: SearchProvider, lang: string): string | null {
	if (!lang) return null;
	if (provider === 'brave') return braveLanguage(lang);
	if (provider === 'duckduckgo') return ddgRegion(lang) || null;
	if (provider === 'searxng') return lang;
	return null;
}

/**
 * A provider-level failure: blocked, unreachable, or a response we cannot
 * parse. Deliberately distinct from "zero results", which is a valid answer —
 * conflating the two is what made this silently unfixable in production.
 */
export class SearchProviderError extends Error {
	constructor(
		public provider: string,
		public reason: string,
		public status?: number,
		public bytes?: number
	) {
		super(
			`${provider} search failed: ${reason}` +
				(status !== undefined ? ` (HTTP ${status}` : '') +
				(status !== undefined && bytes !== undefined ? `, ${bytes} bytes)` : status !== undefined ? ')' : '')
		);
		this.name = 'SearchProviderError';
	}
}

export const webSearchToolDef: ToolDef = {
	name: 'web_search',
	description:
		'Search the web for current information. Returns ranked results with title, URL and a short ' +
		'snippet. ' +
		'Queries may be written in any language, and should be: to find German sources, search in ' +
		'German. Set `language` as well to bias the engine towards that language\'s index. ' +
		'Work in stages: open with a broad query, read the titles and domains it returns to see ' +
		'how the subject is actually covered, then search again aimed at what they revealed. A ' +
		'second, better-aimed query is usually worth more than a first, longer one. ' +
		'Searches are rationed per turn as well as per request — a query past that ration is not ' +
		'run, and asking for one costs you the turn you could have spent reading. ' +
		'Snippets are short by design — they are for choosing what to open, not for answering from. ' +
		'Use fetch_url to read anything a claim will rest on; unlike searching, those can be ' +
		'batched, so ask for every page you want in one turn. ' +
		'Searches per request are limited, and repeating a query already run returns the same ' +
		'results without helping.',
	parameters: {
		type: 'object',
		properties: {
			query: {
				type: 'string',
				description: 'The search query, written in the language you want results in'
			},
			language: {
				type: 'string',
				description:
					"Optional BCP-47 language code biasing which index is searched, e.g. 'de', 'ja', " +
					"'pt-br', 'es'. Omit to search without a language constraint."
			}
		},
		required: ['query']
	}
};

/** Snippets are provider-controlled and occasionally enormous. */
const MAX_SNIPPET_CHARS = 240;
const MIN_SNIPPET_CHARS = 80;

/**
 * Total snippet text one rendered listing aims for, across all of its results.
 *
 * The listing is not paid for once. It stays in the message array and is re-sent
 * on every later round-trip of the turn, so its size is multiplied by whatever
 * the model does next — which is why it is budgeted as a whole rather than per
 * row.
 */
const SNIPPET_BUDGET_CHARS = 2_000;

/**
 * How much snippet each result gets, given how many are being rendered.
 *
 * Twenty results at the old flat 240 would have been four times the snippet text
 * of five, for the same single provider request. Twenty at 100 is 1.7 times it,
 * and buys fifteen more places to look — and the snippet is the right thing to
 * spend first, being the one part of a result its own publisher wrote to be
 * picked. Few results still get the full length: an admin who has deliberately
 * narrowed `maxResults` should not also lose the detail.
 */
export function renderSnippetChars(resultCount: number): number {
	if (resultCount <= 0) return MAX_SNIPPET_CHARS;
	const share = Math.floor(SNIPPET_BUDGET_CHARS / resultCount);
	return Math.min(MAX_SNIPPET_CHARS, Math.max(MIN_SNIPPET_CHARS, share));
}

/**
 * Render results for the model. A compact numbered list rather than raw JSON:
 * fewer tokens, easier to skim, and the same shape as library_search.
 */
export function formatSearchResults(
	results: SearchResult[],
	query: string,
	outcome?: Pick<SearchOutcome, 'provider' | 'language' | 'languageApplied' | 'degraded'>
): string {
	// A language the provider could not honour is worth one line: without it a
	// model reads the off-language results as the tool having ignored it.
	const note =
		outcome?.language && outcome.languageApplied === false
			? `\n(${outcome.provider} cannot filter by language, so these results are unfiltered — the wording of the query is what steers them. Write the query in ${outcome.language} if you have not already.)`
			: '';

	// Engines that did not answer. Stated wherever it happened, because thin
	// results from a half-working provider read exactly like thin results from
	// a thin subject.
	const degraded = outcome?.degraded
		? `\n(Some search engines did not answer: ${outcome.degraded.engines.join(', ')}. These results are therefore incomplete — treat them as a partial view, not as everything that exists.)`
		: '';

	if (!results.length) {
		// `[]` told the model nothing, so its next move was always to rephrase
		// and search again. Say what happened instead — but only claim the
		// search worked when it demonstrably did. Asserting "there is simply
		// nothing indexed" over a provider whose engines had all failed is how
		// an outage was passed off to the model as a fact about the world.
		if (outcome?.degraded) {
			return `No results for "${query}", but the search did not work properly: ${outcome.degraded.engines.join(', ')} did not answer. This is a tooling failure, not evidence that nothing exists. Say so rather than concluding the subject has no coverage; the same query is worth trying again.`;
		}
		return `No results for "${query}". The search worked — there is simply nothing indexed for these terms. Try broader or different wording, or answer from what you already know and say the search found nothing. Do not repeat this query.${note}`;
	}
	const snippetChars = renderSnippetChars(results.length);
	return (
		degraded +
		results
			.map((r, i) => {
				const snippet = r.snippet.replace(/\s+/g, ' ').trim();
				const trimmed =
					snippet.length > snippetChars ? `${snippet.slice(0, snippetChars)}…` : snippet;
				return `${i + 1}. ${r.title.trim() || '(untitled)'}\n   ${r.url}\n   ${trimmed}`;
			})
			.join('\n') + note
	);
}

/** Same question asked twice shouldn't cost two searches. */
export function normaliseQuery(query: string): string {
	return query.toLowerCase().replace(/["']/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Memo key. The language belongs in it: the same words searched in two
 * languages are two different searches, and keying on the query alone served
 * the second one from the first one's results.
 */
export function memoKey(query: string, language: string): string {
	return `${normaliseQuery(query)}|${language}`;
}

export interface SearchToolDeps {
	/** Injectable for tests; defaults to the real provider call. */
	search?: (query: string, cfg: WebSearchSettings, language?: string) => Promise<SearchOutcome>;
	/**
	 * What one allowance covers, for the Observatory and for the wording the
	 * model sees. A chat turn is one request; a coding leg is one leg of one.
	 */
	scope?: 'request' | 'leg';
	/** Injectable for tests; defaults to the provider's own pacing. */
	pacer?: Pacer;
}

/** What a memo hit has to replay: the model's text, and the rows the box drew. */
interface MemoEntry {
	text: string;
	rows: SearchResultRow[];
}

/** Provider results reduced to what the timeline box draws. */
export const displayRows = (results: readonly SearchResult[]): SearchResultRow[] =>
	results.map((r) => ({ title: r.title.trim() || '(untitled)', url: r.url }));

/**
 * Build the web_search tool for one turn. State lives in the closure, so the
 * memo and the budget belong to that turn alone and can't leak between chats —
 * a later message always starts with a full allowance.
 */
export function webSearchTool(cfg: WebSearchSettings, deps: SearchToolDeps = {}): LoopTool {
	const search = deps.search ?? runWebSearch;
	const scope = deps.scope ?? 'request';
	const budget = Math.max(1, cfg.maxSearchesPerTurn ?? DEFAULT_MAX_SEARCHES);
	// What one *round-trip* may spend, as opposed to what the turn may. The turn
	// allowance was never the thing going wrong: six searches over six model
	// turns is deliberate research, and six in one message is six guesses written
	// before any of them came back.
	const perStep = Math.max(1, cfg.searchesPerStep ?? DEFAULT_SEARCHES_PER_STEP);
	let usedThisStep = 0;
	const memo = new Map<string, MemoEntry>();
	// Per turn, like the memo and the allowance: a turn that tripped a rate limit
	// should not hand its throttle to the next message.
	const pacer = deps.pacer ?? createPacer(cfg.provider);
	const gate = createGate(pacer);
	let used = 0;

	return {
		// The ration is configurable, so it is stated per instance rather than in
		// the static definition — a description that says "one" under a setting of
		// two is the same class of bug as the batching advice this rule exists to
		// undo. `webSearchToolDef` stays canonical for the admin tool list, which
		// has no settings to read.
		def: {
			...webSearchToolDef,
			description: `${webSearchToolDef.description} You may run ${perStep === 1 ? 'one search' : `${perStep} searches`} per turn.`
		},
		beginStep: () => {
			usedThisStep = 0;
		},
		describe: (args) => {
			const lang = normaliseLanguage(args.language);
			return `${String(args.query ?? '')}${lang ? ` [${lang}]` : ''}`;
		},
		execute: async (args, report) => {
			const query = String(args.query ?? '').trim();
			if (!query) throw new Error('query is required');
			// The tool argument wins; the admin default only fills a gap.
			const language = normaliseLanguage(args.language) || normaliseLanguage(cfg.defaultLanguage);

			const key = memoKey(query, language);
			const cached = memo.get(key);
			if (cached !== undefined) {
				report?.({
					cached: true,
					searchesUsed: used,
					searchBudget: budget,
					scope,
					language,
					// Replayed so the second call draws its own box rather than an
					// empty row: the results are the same, and saying so is the point.
					display: { results: cached.rows }
				});
				return `(already searched "${query}" this ${scope} — unchanged results below)\n${cached.text}`;
			}

			// After the memo, before the budget. A repeat is free and worth replaying
			// whenever it is asked for; a second *new* query in the same round-trip
			// is the thing being stopped, and stopping it must cost nothing, or the
			// model pays for the loop's rule out of its own allowance.
			if (usedThisStep >= perStep) {
				report?.({ deferred: true, searchesUsed: used, searchBudget: budget, scope, perStep });
				// Deliberately does not promise a next turn: the tool cannot see how
				// many round-trips are left, and on the last one this search is
				// simply lost. "If it still matters" is true either way.
				return (
					`Not run: "${query}". You have already used ${perStep === 1 ? 'this turn\'s search' : `all ${perStep} of this turn's searches`} and the results are above — read them first, and open anything a claim will rest on with fetch_url. ` +
					`A query written before the last one came back is a guess; the one you write after reading is usually a different and better query. ` +
					`Nothing was spent (${budget - used} of ${budget} searches still available this ${scope}), so if it still matters once you have read these, search again.`
				);
			}

			if (used >= budget) {
				report?.({ budgetExhausted: true, searchesUsed: used, searchBudget: budget, scope });
				// Names the scope and the way out: the old wording said "this
				// turn" with no hint that it ever refills, so a model treated it
				// as a standing prohibition and stopped offering to look again.
				return `Search budget for this ${scope} is spent (${budget} searches). Answer with what you have and be explicit about anything you could not confirm. A new message starts a fresh allowance.`;
			}

			// Claim the allowance, then wait for the provider's gap. Claiming first
			// is what stops two calls deciding they both have the last search.
			used++;
			usedThisStep++;
			await gate();
			let outcome: SearchOutcome;
			try {
				outcome = await search(query, cfg, language);
			} catch (err) {
				// A refusal is the only thing that tells us how hard we are pushing;
				// feed it back before the next search claims its turn.
				pacer.observe([String(err)]);
				throw err;
			}
			pacer.observe(outcome.degraded?.engines ?? []);
			const rows = displayRows(outcome.results);
			report?.({
				provider: outcome.provider,
				results: outcome.results.length,
				searchesUsed: used,
				searchBudget: budget,
				scope,
				...(pacer.pacing.throttled ? { pacing: 'throttled' } : {}),
				...(language ? { language, languageApplied: outcome.languageApplied !== false } : {}),
				...(outcome.languageSent ? { languageSent: outcome.languageSent } : {}),
				...(outcome.failedOver ? { failedOver: outcome.failedOver } : {}),
				// Named in the Observatory so a partly-blocked provider shows as a
				// pattern across a run rather than as consistently thin results.
				...(outcome.degraded ? { unresponsiveEngines: outcome.degraded.engines } : {}),
				// Split off in the loop: this reaches the browser, never the events
				// table, and never the model.
				display: { results: rows }
			});
			const remaining = budget - used;
			// The count alone reads as an invitation to spend it. What comes next is
			// reading, and saying so is the last thing the model sees before it
			// chooses — which is why it is worth the line.
			const next = outcome.results.length
				? ' Read the ones a claim will rest on with fetch_url before searching again.'
				: '';
			const ration = perStep === 1 ? ', one per turn' : `, ${perStep} per turn`;
			const tally = remaining
				? `\n(${remaining} more search${remaining === 1 ? '' : 'es'} available this ${scope}${ration}.${next})`
				: `\n(that was the last search available this ${scope}.${next})`;
			const text = formatSearchResults(outcome.results, query, outcome);
			// A query that genuinely found nothing is exactly the one worth not
			// running twice — but a degraded search is not a finding about the
			// world, and caching one froze a transient engine outage in as fact
			// for the rest of the turn. The tally is outside the memo so a replay
			// doesn't restate a count that has since moved.
			if (!outcome.degraded) memo.set(key, { text, rows });
			return text + tally;
		}
	};
}

const DEFAULT_MAX_SEARCHES = 6;

/** One, so that a search is always read before the next one is written. */
const DEFAULT_SEARCHES_PER_STEP = 1;

/**
 * Some browsers' UA. A bot-shaped UA is itself a reason to get blocked.
 *
 * Exported because the pages a search returns need it at least as much as the
 * search engine does — research used to browser-shape its request to the engine
 * and then announce itself as `galaxy-research/1.0` to everything it found.
 */
export const BROWSER_UA =
	'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export function providerConfigured(provider: SearchProvider, cfg: WebSearchSettings): boolean {
	if (provider === 'brave' || provider === 'tavily') return Boolean(cfg.apiKeyEnc);
	if (provider === 'searxng') return Boolean(cfg.baseUrl);
	if (provider === 'duckduckgo') return true; // keyless
	return false;
}

export function webSearchConfigured(cfg: WebSearchSettings): boolean {
	return providerConfigured(cfg.provider, cfg);
}

function apiKey(cfg: WebSearchSettings): string {
	return cfg.apiKeyEnc ? decryptSecret(cfg.apiKeyEnc) : '';
}

/**
 * How fast a run is allowed to search.
 *
 * A round used to fire every query at once, and SearXNG fans each of those out
 * to every enabled engine, so three queries became eighteen near-simultaneous
 * requests from one address. The engines' answer was `too many requests` and
 * `CAPTCHA` — they were measuring the pattern, not the disguise, which is why
 * no amount of header-dressing moved it.
 */
export interface Pacing {
	/** Searches that may be in flight at once. */
	concurrency: number;
	/** Minimum spacing between two searches *starting*. */
	gapMs: number;
	/** Whether this is the tightened pacing rather than the provider's normal. */
	throttled: boolean;
}

/**
 * "You are asking too often", as distinct from "this engine is broken".
 *
 * The distinction is the whole point: slowing down fixes the first and does
 * nothing for the second, and a run that throttles itself because an engine had
 * a DNS error has simply become slower for no reason.
 */
export function isRateLimitReason(reason: unknown): boolean {
	if (typeof reason !== 'string') return false;
	return /too many requests|unusual traffic|captcha|rate.?limit|\b429\b|quota|throttl/i.test(
		reason
	);
}

/**
 * The provider refused the request itself, as opposed to failing to answer it.
 *
 * A 4xx that is not a rate limit means it did not like something we sent — which
 * for a search carrying a language is almost always the language. Worth one more
 * attempt without it; a 5xx or a timeout is not.
 */
export function isRejection(err: SearchProviderError): boolean {
	return typeof err.status === 'number' && err.status >= 400 && err.status < 500 && err.status !== 429;
}


/**
 * What a provider tolerates before anything has gone wrong.
 *
 * Brave is metered per second on its free tier, so it starts serial with a gap
 * rather than discovering the limit by tripping it. The gap is deliberately
 * conservative — the exact free-tier rate is Brave's to change, and
 * `SEARCH_PROVIDER_GAP_MS` exists for anyone who has read their current plan.
 */
export function basePacing(provider: SearchProvider): Pacing {
	if (provider === 'brave') {
		return { concurrency: 1, gapMs: Math.round(searchProviderGapMs()), throttled: false };
	}
	return { concurrency: Math.max(1, Math.round(searchConcurrency())), gapMs: 0, throttled: false };
}

/**
 * Given what a search reported, how the rest of the run should behave.
 *
 * One-way on purpose. SearXNG benches a blocked engine for anywhere from three
 * minutes to an hour, so a run that sped back up after one quiet search would
 * only spend its remaining searches on engines that are still out.
 */
export function nextPacing(current: Pacing, sawRateLimit: boolean): Pacing {
	if (!sawRateLimit || current.throttled) return current;
	return {
		concurrency: 1,
		gapMs: Math.max(current.gapMs, Math.round(searchThrottledGapMs())),
		throttled: true
	};
}

/** The live pacing for one run, plus the feedback that tightens it. */
export interface Pacer {
	readonly pacing: Pacing;
	/**
	 * Feed back the reasons a search came home with — SearXNG's unresponsive
	 * engines, a provider error. Returns true the one time this tips the run
	 * into throttling, so the caller can say so once rather than per query.
	 */
	observe(reasons: readonly unknown[]): boolean;
}

/**
 * Created per research run, so it is unambiguously per request: a second run
 * starts from the provider's normal pacing rather than inheriting a throttle
 * from someone else's rate limit.
 */
export function createPacer(provider: SearchProvider): Pacer {
	let pacing = basePacing(provider);
	return {
		get pacing() {
			return pacing;
		},
		observe(reasons) {
			const next = nextPacing(pacing, reasons.some(isRateLimitReason));
			const engaged = next.throttled && !pacing.throttled;
			pacing = next;
			return engaged;
		}
	};
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait for your turn to search, under a pacer.
 *
 * `runPaced` cannot serve this: it owns a whole batch up front and retires
 * workers against the concurrency, whereas the agent loop hands over tool calls
 * one at a time and only needs the next one to wait out the gap. That gap is the
 * part chat was missing — the loop already executes a batch serially, so
 * concurrency was never the problem, but with nothing between them two searches
 * fired as fast as the first returned, which is exactly what Brave's
 * one-per-second free tier refuses.
 *
 * Chained rather than clock-checked, so that two callers who both read the time
 * before either has started cannot both conclude the gap has elapsed. The pacer
 * is read on every claim rather than captured, so a rate limit seen by one
 * search tightens the ones behind it.
 */
export function createGate(pacer: Pacer): () => Promise<void> {
	let lastStart = 0;
	let queue: Promise<void> = Promise.resolve();
	return () => {
		const turn = queue.then(async () => {
			const gap = pacer.pacing.gapMs;
			const now = Date.now();
			const startAt = gap > 0 ? Math.max(now, lastStart + gap) : now;
			lastStart = startAt;
			if (startAt > now) await sleep(startAt - now);
		});
		// A caller that gives up must not wedge the queue for everyone after it.
		queue = turn.catch(() => {});
		return turn;
	};
}

/**
 * Run `task` over `items` under a pacer, returning results in *item* order
 * however they finish.
 *
 * The pacer is read on every claim rather than captured up front, so a rate
 * limit seen by the first search tightens the ones still queued behind it.
 */
export async function runPaced<T, R>(
	items: readonly T[],
	pacer: Pacer,
	task: (item: T, index: number) => Promise<R>
): Promise<(R | undefined)[]> {
	const out: (R | undefined)[] = new Array(items.length).fill(undefined);
	let next = 0;
	let lastStart = 0;

	const worker = async (slot: number) => {
		for (;;) {
			// A worker whose slot no longer exists retires: this is how tightening
			// to serial takes effect on a round that is already in flight.
			if (slot >= pacer.pacing.concurrency) return;
			const index = next++;
			if (index >= items.length) return;

			// Reserve the start instant synchronously, so two workers cannot both
			// decide the gap has already elapsed and start together.
			const gap = pacer.pacing.gapMs;
			const now = Date.now();
			const startAt = gap > 0 ? Math.max(now, lastStart + gap) : now;
			lastStart = startAt;
			if (startAt > now) await sleep(startAt - now);

			try {
				out[index] = await task(items[index], index);
			} catch {
				// One query failing is a thin round, not a dead one.
				out[index] = undefined;
			}
		}
	};

	const slots = Math.max(1, Math.min(items.length, pacer.pacing.concurrency));
	await Promise.all(Array.from({ length: slots }, (_, slot) => worker(slot)));
	return out;
}

/**
 * Run a search, falling back to the configured secondary provider when the
 * primary *fails*. A genuine empty result is an answer, not a failure, and
 * never triggers failover.
 */
export async function runWebSearch(
	query: string,
	cfg: WebSearchSettings,
	language?: string
): Promise<SearchOutcome> {
	const lang = normaliseLanguage(language) || normaliseLanguage(cfg.defaultLanguage);
	const outcome = (
		answer: ProviderAnswer,
		provider: SearchProvider,
		applied: boolean,
		sent?: string | null
	): SearchOutcome => ({
		results: answer.results,
		provider,
		...(answer.degraded ? { degraded: answer.degraded } : {}),
		...(lang ? { language: lang, languageApplied: applied } : {}),
		...(sent ? { languageSent: sent } : {})
	});

	/**
	 * Ask one provider, dropping the language if it turns out to refuse it.
	 *
	 * `providerLanguage` already declines a tag the provider has no value for, so
	 * this is for the case it cannot know about: an allowlist that has moved.
	 * Results in the wrong language beat no results, and it means a future change
	 * to Brave's enum degrades instead of silently emptying every tagged search.
	 */
	const ask = async (
		provider: SearchProvider
	): Promise<{ answer: ProviderAnswer; applied: boolean; sent: string | null }> => {
		const wanted = providerLanguage(provider, lang);
		try {
			return {
				answer: await searchWith(provider, query, cfg, lang),
				applied: Boolean(wanted),
				sent: wanted
			};
		} catch (err) {
			if (!wanted || !(err instanceof SearchProviderError) || !isRejection(err)) throw err;
			return { answer: await searchWith(provider, query, cfg, ''), applied: false, sent: null };
		}
	};

	try {
		const first = await ask(cfg.provider);
		return outcome(first.answer, cfg.provider, first.applied, first.sent);
	} catch (err) {
		const fallback = cfg.fallbackProvider;
		if (
			!(err instanceof SearchProviderError) ||
			!fallback ||
			fallback === 'none' ||
			fallback === cfg.provider ||
			!providerConfigured(fallback, cfg)
		) {
			throw err;
		}
		const second = await ask(fallback);
		return {
			...outcome(second.answer, fallback, second.applied, second.sent),
			failedOver: { from: cfg.provider, reason: err.reason }
		};
	}
}

/** Engines that did not answer, when some still did. */
export interface DegradedSearch {
	engines: string[];
	reason: string;
}

/** What one provider returned, plus anything it said about its own health. */
interface ProviderAnswer {
	results: SearchResult[];
	degraded?: DegradedSearch;
}

async function searchWith(
	provider: SearchProvider,
	query: string,
	cfg: WebSearchSettings,
	language = ''
): Promise<ProviderAnswer> {
	const signal = AbortSignal.timeout(cfg.timeoutMs);
	switch (provider) {
		case 'duckduckgo': {
			// Keyless: DuckDuckGo's no-JS HTML endpoint, parsed directly.
			const ddgLang = providerLanguage(provider, language);
			const res = await fetchOrThrow(
				provider,
				'https://html.duckduckgo.com/html/',
				{
					method: 'POST',
					headers: {
						'content-type': 'application/x-www-form-urlencoded',
						'user-agent': BROWSER_UA,
						accept: 'text/html,application/xhtml+xml'
					},
					// `kl` is DuckDuckGo's region-language selector.
					body:
						`q=${encodeURIComponent(query)}` +
						(ddgLang ? `&kl=${encodeURIComponent(ddgLang)}` : ''),
					signal
				}
			);
			const html = await res.text();
			assertLooksLikeDuckDuckGoResults(html, res.status);
			return { results: parseDuckDuckGoHtml(html, cfg.maxResults) };
		}
		case 'brave': {
			const searchLang = braveLanguage(language);
			const res = await fetchOrThrow(
				provider,
				`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${cfg.maxResults}` +
					(searchLang ? `&search_lang=${encodeURIComponent(searchLang)}` : ''),
				{ headers: { 'X-Subscription-Token': apiKey(cfg), accept: 'application/json' }, signal }
			);
			const data = await parseJsonOrThrow(provider, res);
			// Brave answers a query with no hits as `web: { results: [] }`, so a
			// body with no `web` at all is a shape we do not understand rather than
			// an empty result — the same distinction SearXNG and DuckDuckGo get.
			if (!data.web || !Array.isArray(data.web.results)) {
				throw new SearchProviderError(
					provider,
					'response carried no web results object (the API shape may have changed, or the key may lack access to web search)',
					res.status
				);
			}
			const rows: Record<string, string>[] = data.web.results;
			return {
				results: rows.slice(0, cfg.maxResults).map((r) => ({
					title: r.title ?? '',
					url: r.url ?? '',
					snippet: r.description ?? ''
				}))
			};
		}
		case 'tavily': {
			const res = await fetchOrThrow(provider, 'https://api.tavily.com/search', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ api_key: apiKey(cfg), query, max_results: cfg.maxResults }),
				signal
			});
			const data = await parseJsonOrThrow(provider, res);
			const rows: Record<string, string>[] = data.results ?? [];
			return {
				results: rows.map((r) => ({
					title: r.title ?? '',
					url: r.url ?? '',
					snippet: r.content ?? ''
				}))
			};
		}
		case 'searxng': {
			const base = (cfg.baseUrl ?? '').replace(/\/$/, '');
			if (!base) throw new SearchProviderError(provider, 'no instance URL configured');
			const searxLang = providerLanguage(provider, language);
			const res = await fetchOrThrow(
				provider,
				`${base}/search?q=${encodeURIComponent(query)}&format=json` +
					(searxLang ? `&language=${encodeURIComponent(searxLang)}` : ''),
				{ headers: { accept: 'application/json', 'user-agent': BROWSER_UA }, signal }
			);
			const data = await parseJsonOrThrow(provider, res, 'is the JSON format enabled? SearXNG needs `search.formats` to include `json`');
			const rows: Record<string, string>[] = data.results ?? [];
			const down = parseUnresponsiveEngines(data.unresponsive_engines);
			// SearXNG answers 200 with an empty list whether the query found
			// nothing or every engine failed — and it says which in the same body.
			// Without this the two are identical, the fallback provider never
			// fires, and the model is told the web has nothing on the subject.
			// This is the SearXNG counterpart of assertLooksLikeDuckDuckGoResults.
			if (!rows.length && down.length) {
				throw new SearchProviderError(
					provider,
					`every engine failed — ${down.join(', ')}. Ask the instance directly to see why: \`docker compose exec searxng python -c "import urllib.request; print(urllib.request.urlopen('http://localhost:8080/search?q=test&format=json',timeout=20).read()[:800])"\`. CAPTCHA and rate-limit reasons mean the engines are refusing us; DNS or connection errors mean the container cannot reach the internet`,
					res.status
				);
			}
			return {
				results: rows.slice(0, cfg.maxResults).map((r) => ({
					title: r.title ?? '',
					url: r.url ?? '',
					snippet: r.content ?? ''
				})),
				// Some engines answered and some did not: results are thinner than
				// they should be, which is worth saying rather than passing off as
				// the whole of what exists.
				...(down.length ? { degraded: { engines: down, reason: 'engines did not answer' } } : {})
			};
		}
		default:
			throw new SearchProviderError(
				provider,
				'web search is not configured — set a provider in admin settings'
			);
	}
}

async function fetchOrThrow(
	provider: SearchProvider,
	url: string,
	init: RequestInit
): Promise<Response> {
	let res: Response;
	try {
		res = await fetch(url, init);
	} catch (err) {
		// Network failure, DNS, TLS or timeout — never reached the provider.
		const reason = (err as Error)?.name === 'TimeoutError' ? 'request timed out' : 'unreachable';
		throw new SearchProviderError(provider, `${reason} (${String(err)})`);
	}
	if (!res.ok) {
		const body = await res.text().catch(() => '');
		throw new SearchProviderError(
			provider,
			// Long enough to reach the useful part. A validation error opens with
			// boilerplate and names the values it wanted at the end, so clipping at
			// 200 characters reliably kept the boilerplate and threw the answer away.
			body.trim() ? `rejected: ${body.slice(0, 900).replace(/\s+/g, ' ')}` : 'rejected',
			res.status,
			body.length
		);
	}
	return res;
}

/**
 * The parts of a provider's JSON body anything reads.
 *
 * `unresponsive_engines` was previously unreachable: the return type here was
 * `Record<string, never>`, so reading it would not even typecheck. SearXNG puts
 * the whole diagnosis in it — `[["duckduckgo","DNS error"],["brave","CAPTCHA"]]`
 * — and without it an instance whose engines had all failed was indistinguishable
 * from a query the web has no answer for.
 */
export interface SearchResponseBody {
	results?: Record<string, string>[];
	web?: { results?: Record<string, string>[] };
	/** SearXNG: `[engine, reason]` pairs for every engine that did not answer. */
	unresponsive_engines?: unknown;
	number_of_results?: number;
}

/** `[["duckduckgo","DNS error"]]` → `["duckduckgo (DNS error)"]`. */
export function parseUnresponsiveEngines(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	const out: string[] = [];
	for (const entry of raw) {
		if (typeof entry === 'string' && entry.trim()) {
			out.push(entry.trim());
			continue;
		}
		if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue;
		const name = entry[0].trim();
		if (!name) continue;
		const reason = typeof entry[1] === 'string' ? entry[1].trim() : '';
		out.push(reason ? `${name} (${reason})` : name);
	}
	return out;
}

async function parseJsonOrThrow(
	provider: SearchProvider,
	res: Response,
	hint?: string
): Promise<SearchResponseBody> {
	const text = await res.text();
	try {
		return JSON.parse(text);
	} catch {
		// An HTML body here usually means a login/consent/error page, not JSON.
		throw new SearchProviderError(
			provider,
			`expected JSON, got ${text.trim().startsWith('<') ? 'HTML' : 'unparseable text'}${hint ? ` — ${hint}` : ''}`,
			res.status,
			text.length
		);
	}
}

/** Markers DuckDuckGo serves on its bot-check / rate-limit page (with HTTP 200). */
const DDG_BLOCK_MARKERS = [
	'anomaly',
	'unfortunately, bots use duckduckgo too',
	'detected unusual activity',
	'/t/challenge',
	'captcha'
];

/**
 * DuckDuckGo answers a blocked request with HTTP 200 and a bot-check page, so
 * status alone proves nothing. Treat a body with no results *container* as a
 * provider failure; a container with no rows is a real "no results".
 */
export function assertLooksLikeDuckDuckGoResults(html: string, status?: number): void {
	const hasResultsContainer = /id="links"|class="results|class="result\b|result__a|no-results/i.test(
		html
	);
	if (hasResultsContainer) return;
	const lower = html.toLowerCase();
	const marker = DDG_BLOCK_MARKERS.find((m) => lower.includes(m));
	throw new SearchProviderError(
		'duckduckgo',
		marker
			? `blocked by DuckDuckGo (matched "${marker}") — datacenter IPs are commonly rate-limited; consider SearXNG`
			: 'response contained no recognisable results markup (the page layout may have changed, or the request was blocked)',
		status,
		html.length
	);
}

/**
 * Parse DuckDuckGo's no-JS HTML result page. Result links use a redirect of
 * the form //duckduckgo.com/l/?uddg=<encoded-target>, which we unwrap.
 * Returning an empty array here is only meaningful after
 * assertLooksLikeDuckDuckGoResults has confirmed this really is a results page.
 */
export function parseDuckDuckGoHtml(html: string, max: number): SearchResult[] {
	const results: SearchResult[] = [];
	const blockRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
	const snippetRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
	const snippets: string[] = [];
	for (let m = snippetRe.exec(html); m; m = snippetRe.exec(html)) {
		snippets.push(stripTags(m[1]));
	}
	let i = 0;
	for (let m = blockRe.exec(html); m && results.length < max; m = blockRe.exec(html)) {
		results.push({
			title: stripTags(m[2]),
			url: unwrapDuckDuckGoUrl(m[1]),
			snippet: snippets[i] ?? ''
		});
		i++;
	}
	return results;
}

function unwrapDuckDuckGoUrl(href: string): string {
	const decoded = href.replace(/&amp;/g, '&');
	const m = decoded.match(/[?&]uddg=([^&]+)/);
	if (m) {
		try {
			return decodeURIComponent(m[1]);
		} catch {
			/* fall through */
		}
	}
	return decoded.startsWith('//') ? `https:${decoded}` : decoded;
}

function stripTags(s: string): string {
	return s
		.replace(/<[^>]+>/g, '')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#x27;/g, "'")
		.replace(/&#39;/g, "'")
		.replace(/\s+/g, ' ')
		.trim();
}
