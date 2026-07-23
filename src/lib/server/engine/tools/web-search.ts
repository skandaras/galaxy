import type { ToolDef } from '$lib/server/providers/types';
import type { WebSearchSettings } from '$lib/server/settings';
import { decryptSecret } from '$lib/server/crypto';

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
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

export function webSearchConfigured(cfg: WebSearchSettings): boolean {
	if (cfg.provider === 'brave' || cfg.provider === 'tavily') return Boolean(cfg.apiKeyEnc);
	if (cfg.provider === 'searxng') return Boolean(cfg.baseUrl);
	return false;
}

function apiKey(cfg: WebSearchSettings): string {
	return cfg.apiKeyEnc ? decryptSecret(cfg.apiKeyEnc) : '';
}

export async function runWebSearch(
	query: string,
	cfg: WebSearchSettings
): Promise<SearchResult[]> {
	const signal = AbortSignal.timeout(cfg.timeoutMs);
	switch (cfg.provider) {
		case 'brave': {
			const res = await fetch(
				`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${cfg.maxResults}`,
				{ headers: { 'X-Subscription-Token': apiKey(cfg) }, signal }
			);
			if (!res.ok) throw new Error(`Brave search failed: ${res.status}`);
			const data = await res.json();
			const rows: Record<string, string>[] = data.web?.results ?? [];
			return rows.slice(0, cfg.maxResults).map((r) => ({
				title: r.title ?? '',
				url: r.url ?? '',
				snippet: r.description ?? ''
			}));
		}
		case 'tavily': {
			const res = await fetch('https://api.tavily.com/search', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ api_key: apiKey(cfg), query, max_results: cfg.maxResults }),
				signal
			});
			if (!res.ok) throw new Error(`Tavily search failed: ${res.status}`);
			const data = await res.json();
			const rows: Record<string, string>[] = data.results ?? [];
			return rows.map((r) => ({
				title: r.title ?? '',
				url: r.url ?? '',
				snippet: r.content ?? ''
			}));
		}
		case 'searxng': {
			const base = (cfg.baseUrl ?? '').replace(/\/$/, '');
			const res = await fetch(
				`${base}/search?q=${encodeURIComponent(query)}&format=json`,
				{ signal }
			);
			if (!res.ok) throw new Error(`SearXNG search failed: ${res.status}`);
			const data = await res.json();
			const rows: Record<string, string>[] = data.results ?? [];
			return rows.slice(0, cfg.maxResults).map((r) => ({
				title: r.title ?? '',
				url: r.url ?? '',
				snippet: r.content ?? ''
			}));
		}
		default:
			throw new Error('Web search is not configured — set a provider in admin settings');
	}
}
