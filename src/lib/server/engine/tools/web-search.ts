import type { ToolDef } from '$lib/server/providers/types';
import type { SearchProvider, WebSearchSettings } from '$lib/server/settings';
import { decryptSecret } from '$lib/server/crypto';

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
		'Search the web for current information. Returns a JSON list of results with title, url and snippet.',
	parameters: {
		type: 'object',
		properties: {
			query: { type: 'string', description: 'The search query' }
		},
		required: ['query']
	}
};

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
	cfg: WebSearchSettings
): Promise<SearchOutcome> {
	try {
		return { results: await searchWith(cfg.provider, query, cfg), provider: cfg.provider };
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
			results: await searchWith(fallback, query, cfg),
			provider: fallback,
			failedOver: { from: cfg.provider, reason: err.reason }
		};
	}
}

async function searchWith(
	provider: SearchProvider,
	query: string,
	cfg: WebSearchSettings
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
					body: `q=${encodeURIComponent(query)}`,
					signal
				}
			);
			const html = await res.text();
			assertLooksLikeDuckDuckGoResults(html, res.status);
			return parseDuckDuckGoHtml(html, cfg.maxResults);
		}
		case 'brave': {
			const res = await fetchOrThrow(
				provider,
				`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${cfg.maxResults}`,
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
				`${base}/search?q=${encodeURIComponent(query)}&format=json`,
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
