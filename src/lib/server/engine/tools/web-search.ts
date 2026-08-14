import type { ToolDef } from '$lib/server/providers/types';
import type { SearchProvider, WebSearchSettings } from '$lib/server/settings';
import { decryptSecret } from '$lib/server/crypto';
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
	/** Language the search was asked to bias towards, if any. */
	language?: string;
	/**
	 * False when a language was asked for and the provider has no parameter for
	 * it. Not a failure — the query wording still does most of the work — but
	 * the model needs telling, or it reads thin results as the tool misbehaving.
	 */
	languageApplied?: boolean;
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

/** Providers that can genuinely constrain results to a language. */
function supportsLanguage(provider: SearchProvider): boolean {
	return provider === 'searxng' || provider === 'brave' || provider === 'duckduckgo';
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
		'Search the web for current information. Returns ranked results with title, URL and snippet. ' +
		'Queries may be written in any language, and should be: to find German sources, search in ' +
		'German. Set `language` as well to bias the engine towards that language\'s index. ' +
		'Searches per request are limited, so prefer one well-chosen query over several narrow ones, ' +
		'and do not repeat a query you have already run — it returns the same results.',
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

/**
 * Render results for the model. A compact numbered list rather than raw JSON:
 * fewer tokens, easier to skim, and the same shape as library_search.
 */
export function formatSearchResults(
	results: SearchResult[],
	query: string,
	outcome?: Pick<SearchOutcome, 'provider' | 'language' | 'languageApplied'>
): string {
	// A language the provider could not honour is worth one line: without it a
	// model reads the off-language results as the tool having ignored it.
	const note =
		outcome?.language && outcome.languageApplied === false
			? `\n(${outcome.provider} cannot filter by language, so these results are unfiltered — the wording of the query is what steers them. Write the query in ${outcome.language} if you have not already.)`
			: '';

	if (!results.length) {
		// `[]` told the model nothing, so its next move was always to rephrase
		// and search again. Say what happened instead.
		return `No results for "${query}". The search worked — there is simply nothing indexed for these terms. Try broader or different wording, or answer from what you already know and say the search found nothing. Do not repeat this query.${note}`;
	}
	return (
		results
			.map((r, i) => {
				const snippet = r.snippet.replace(/\s+/g, ' ').trim();
				const trimmed =
					snippet.length > MAX_SNIPPET_CHARS ? `${snippet.slice(0, MAX_SNIPPET_CHARS)}…` : snippet;
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
}

/**
 * Build the web_search tool for one turn. State lives in the closure, so the
 * memo and the budget belong to that turn alone and can't leak between chats —
 * a later message always starts with a full allowance.
 */
export function webSearchTool(cfg: WebSearchSettings, deps: SearchToolDeps = {}): LoopTool {
	const search = deps.search ?? runWebSearch;
	const scope = deps.scope ?? 'request';
	const budget = Math.max(1, cfg.maxSearchesPerTurn ?? DEFAULT_MAX_SEARCHES);
	const memo = new Map<string, string>();
	let used = 0;

	return {
		def: webSearchToolDef,
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
				report?.({ cached: true, searchesUsed: used, searchBudget: budget, scope, language });
				return `(already searched "${query}" this ${scope} — unchanged results below)\n${cached}`;
			}

			if (used >= budget) {
				report?.({ budgetExhausted: true, searchesUsed: used, searchBudget: budget, scope });
				// Names the scope and the way out: the old wording said "this
				// turn" with no hint that it ever refills, so a model treated it
				// as a standing prohibition and stopped offering to look again.
				return `Search budget for this ${scope} is spent (${budget} searches). Answer with what you have and be explicit about anything you could not confirm. A new message starts a fresh allowance.`;
			}

			used++;
			const outcome = await search(query, cfg, language);
			report?.({
				provider: outcome.provider,
				results: outcome.results.length,
				searchesUsed: used,
				searchBudget: budget,
				scope,
				...(language ? { language, languageApplied: outcome.languageApplied !== false } : {}),
				...(outcome.failedOver ? { failedOver: outcome.failedOver } : {})
			});
			const remaining = budget - used;
			const tally = remaining
				? `\n(${remaining} more search${remaining === 1 ? '' : 'es'} available this ${scope})`
				: `\n(that was the last search available this ${scope})`;
			const text = formatSearchResults(outcome.results, query, outcome);
			// Cached either way: a query that found nothing is exactly the one
			// worth not running twice. The tally is outside the memo so a replay
			// doesn't restate a count that has since moved.
			memo.set(key, text);
			return text + tally;
		}
	};
}

const DEFAULT_MAX_SEARCHES = 4;

/** Some browsers' UA. A bot-shaped UA is itself a reason to get blocked. */
const BROWSER_UA =
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
	const outcome = (results: SearchResult[], provider: SearchProvider) => ({
		results,
		provider,
		...(lang ? { language: lang, languageApplied: supportsLanguage(provider) } : {})
	});
	try {
		return outcome(await searchWith(cfg.provider, query, cfg, lang), cfg.provider);
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
		return {
			...outcome(await searchWith(fallback, query, cfg, lang), fallback),
			failedOver: { from: cfg.provider, reason: err.reason }
		};
	}
}

async function searchWith(
	provider: SearchProvider,
	query: string,
	cfg: WebSearchSettings,
	language = ''
): Promise<SearchResult[]> {
	const signal = AbortSignal.timeout(cfg.timeoutMs);
	switch (provider) {
		case 'duckduckgo': {
			// Keyless: DuckDuckGo's no-JS HTML endpoint, parsed directly.
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
						(language ? `&kl=${encodeURIComponent(ddgRegion(language))}` : ''),
					signal
				}
			);
			const html = await res.text();
			assertLooksLikeDuckDuckGoResults(html, res.status);
			return parseDuckDuckGoHtml(html, cfg.maxResults);
		}
		case 'brave': {
			// Brave splits the two: search_lang is the content language, country
			// the market. A bare 'de' sets only the former.
			const [base, region] = language ? language.split('-') : [];
			const res = await fetchOrThrow(
				provider,
				`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${cfg.maxResults}` +
					(base ? `&search_lang=${encodeURIComponent(base)}` : '') +
					(region ? `&country=${encodeURIComponent(region.toUpperCase())}` : ''),
				{ headers: { 'X-Subscription-Token': apiKey(cfg), accept: 'application/json' }, signal }
			);
			const data = await parseJsonOrThrow(provider, res);
			const rows: Record<string, string>[] = data.web?.results ?? [];
			return rows.slice(0, cfg.maxResults).map((r) => ({
				title: r.title ?? '',
				url: r.url ?? '',
				snippet: r.description ?? ''
			}));
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
			return rows.map((r) => ({
				title: r.title ?? '',
				url: r.url ?? '',
				snippet: r.content ?? ''
			}));
		}
		case 'searxng': {
			const base = (cfg.baseUrl ?? '').replace(/\/$/, '');
			if (!base) throw new SearchProviderError(provider, 'no instance URL configured');
			const res = await fetchOrThrow(
				provider,
				`${base}/search?q=${encodeURIComponent(query)}&format=json` +
					(language ? `&language=${encodeURIComponent(language)}` : ''),
				{ headers: { accept: 'application/json', 'user-agent': BROWSER_UA }, signal }
			);
			const data = await parseJsonOrThrow(provider, res, 'is the JSON format enabled? SearXNG needs `search.formats` to include `json`');
			const rows: Record<string, string>[] = data.results ?? [];
			return rows.slice(0, cfg.maxResults).map((r) => ({
				title: r.title ?? '',
				url: r.url ?? '',
				snippet: r.content ?? ''
			}));
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
			body.trim() ? `rejected: ${body.slice(0, 200).replace(/\s+/g, ' ')}` : 'rejected',
			res.status,
			body.length
		);
	}
	return res;
}

async function parseJsonOrThrow(
	provider: SearchProvider,
	res: Response,
	hint?: string
): Promise<Record<string, never> & { web?: { results?: Record<string, string>[] }; results?: Record<string, string>[] }> {
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
