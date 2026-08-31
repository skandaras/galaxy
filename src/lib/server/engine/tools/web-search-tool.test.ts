import { describe, expect, it, vi } from 'vitest';
import type { WebSearchSettings } from '$lib/server/settings';
import {
	basePacing,
	createGate,
	createPacer,
	ddgRegion,
	formatSearchResults,
	memoKey,
	normaliseLanguage,
	normaliseQuery,
	renderSnippetChars,
	webSearchTool,
	type SearchOutcome,
	type SearchResult
} from './web-search';

const cfg = (over: Partial<WebSearchSettings> = {}): WebSearchSettings => ({
	provider: 'searxng',
	baseUrl: 'http://searxng:8080',
	maxResults: 5,
	timeoutMs: 1000,
	maxSearchesPerTurn: 3,
	...over
});

const result = (n: number): SearchResult => ({
	title: `Title ${n}`,
	url: `https://example.com/${n}`,
	snippet: `Snippet ${n}`
});

/** Stub provider that records the queries it was actually asked to run. */
function stubSearch(results: SearchResult[] = [result(1)]) {
	const calls: string[] = [];
	const langs: string[] = [];
	const search = vi.fn(
		async (query: string, _cfg: WebSearchSettings, language = ''): Promise<SearchOutcome> => {
			calls.push(query);
			langs.push(language);
			return { results, provider: 'searxng', ...(language ? { language, languageApplied: true } : {}) };
		}
	);
	return { search, calls, langs };
}

describe('formatSearchResults', () => {
	it('renders a compact numbered list rather than JSON', () => {
		const out = formatSearchResults([result(1), result(2)], 'q');
		expect(out).toContain('1. Title 1');
		expect(out).toContain('https://example.com/1');
		expect(out).toContain('2. Title 2');
		expect(out).not.toContain('{');
	});

	it('trims runaway snippets and collapses whitespace', () => {
		const out = formatSearchResults(
			[{ title: 'T', url: 'u', snippet: `a\n\n   b ${'x'.repeat(500)}` }],
			'q'
		);
		expect(out).toContain('a b');
		expect(out.length).toBeLessThan(400);
		expect(out).toContain('…');
	});

	it('explains an empty result set instead of returning []', () => {
		// `[]` gave the model nothing to act on, so it just rephrased and
		// searched again — the behaviour being fixed.
		const out = formatSearchResults([], 'nothing here');
		expect(out).toContain('No results for "nothing here"');
		expect(out).toMatch(/do not repeat/i);
		expect(out).not.toBe('[]');
	});

	it('survives a result with no title', () => {
		expect(formatSearchResults([{ title: '', url: 'u', snippet: 's' }], 'q')).toContain(
			'(untitled)'
		);
	});
});

describe('normaliseQuery', () => {
	it('treats trivially different phrasings of the same query as one', () => {
		expect(normaliseQuery('  Galaxy   News ')).toBe(normaliseQuery('galaxy news'));
		expect(normaliseQuery('"galaxy news"')).toBe(normaliseQuery('galaxy news'));
	});

	it('keeps genuinely different queries apart', () => {
		expect(normaliseQuery('galaxy news')).not.toBe(normaliseQuery('galaxy history'));
	});
});

describe('webSearchTool', () => {
	it('runs a search and returns the formatted results', async () => {
		const { search, calls } = stubSearch();
		const tool = webSearchTool(cfg(), { search });
		const out = await tool.execute({ query: 'galaxy news' });
		expect(calls).toEqual(['galaxy news']);
		expect(out).toContain('1. Title 1');
	});

	it('serves a repeated query from memory without hitting the provider', async () => {
		const { search } = stubSearch();
		const tool = webSearchTool(cfg(), { search });
		await tool.execute({ query: 'galaxy news' });
		const second = await tool.execute({ query: '  Galaxy News  ' });
		expect(search).toHaveBeenCalledTimes(1);
		expect(second).toContain('already searched');
		expect(second).toContain('1. Title 1');
	});

	it('does not let a repeat consume the budget', async () => {
		const { search } = stubSearch();
		const tool = webSearchTool(cfg({ maxSearchesPerTurn: 2 }), { search });
		await tool.execute({ query: 'a' });
		await tool.execute({ query: 'a' });
		await tool.execute({ query: 'a' });
		const fresh = await tool.execute({ query: 'b' });
		expect(search).toHaveBeenCalledTimes(2);
		expect(fresh).not.toContain('budget');
	});

	it('stops searching once the budget is spent, and says so', async () => {
		const { search } = stubSearch();
		const tool = webSearchTool(cfg({ maxSearchesPerTurn: 2 }), { search });
		await tool.execute({ query: 'a' });
		await tool.execute({ query: 'b' });
		const third = await tool.execute({ query: 'c' });
		expect(search).toHaveBeenCalledTimes(2);
		expect(third).toContain('budget');
		expect(third).toMatch(/answer with what you have/i);
	});

	it('caches an empty result too — that is the query worth not repeating', async () => {
		const { search } = stubSearch([]);
		const tool = webSearchTool(cfg(), { search });
		const first = await tool.execute({ query: 'obscure' });
		const second = await tool.execute({ query: 'obscure' });
		expect(search).toHaveBeenCalledTimes(1);
		expect(first).toContain('No results');
		expect(second).toContain('already searched');
	});

	it('keeps state per turn, so a new tool starts with a full budget', async () => {
		const { search } = stubSearch();
		const first = webSearchTool(cfg({ maxSearchesPerTurn: 1 }), { search });
		await first.execute({ query: 'a' });
		expect(await first.execute({ query: 'b' })).toContain('budget');

		const next = webSearchTool(cfg({ maxSearchesPerTurn: 1 }), { search });
		expect(await next.execute({ query: 'b' })).toContain('1. Title 1');
	});

	it('reports search count and cache hits for the Observatory', async () => {
		const { search } = stubSearch();
		const tool = webSearchTool(cfg(), { search });
		const meta: Record<string, unknown>[] = [];
		await tool.execute({ query: 'a' }, (m) => meta.push(m));
		await tool.execute({ query: 'a' }, (m) => meta.push(m));
		expect(meta[0]).toMatchObject({ results: 1, searchesUsed: 1 });
		expect(meta[1]).toMatchObject({ cached: true });
	});

	it('lets a provider failure surface as an error, not as "no results"', async () => {
		const search = vi.fn(async () => {
			throw new Error('searxng search failed: blocked');
		});
		const tool = webSearchTool(cfg(), { search });
		await expect(tool.execute({ query: 'a' })).rejects.toThrow(/blocked/);
	});

	it('rejects an empty query rather than searching for nothing', async () => {
		const { search } = stubSearch();
		const tool = webSearchTool(cfg(), { search });
		await expect(tool.execute({ query: '   ' })).rejects.toThrow(/required/);
		expect(search).not.toHaveBeenCalled();
	});

	it('always allows at least one search even if the cap is misconfigured', async () => {
		const { search } = stubSearch();
		const tool = webSearchTool(cfg({ maxSearchesPerTurn: 0 }), { search });
		expect(await tool.execute({ query: 'a' })).toContain('1. Title 1');
	});

	it('names the request as the scope, and that a new message refills it', async () => {
		// "this turn" read as a standing prohibition, so a model stopped offering
		// to look again even on the next message, which does have an allowance.
		const { search } = stubSearch();
		const tool = webSearchTool(cfg({ maxSearchesPerTurn: 1 }), { search });
		await tool.execute({ query: 'a' });
		const spent = await tool.execute({ query: 'b' });
		expect(spent).toContain('this request');
		expect(spent).toMatch(/new message starts a fresh allowance/i);
	});

	it('tells the model how much allowance is left, so it can pace itself', async () => {
		const { search } = stubSearch();
		const tool = webSearchTool(cfg({ maxSearchesPerTurn: 3 }), { search });
		expect(await tool.execute({ query: 'a' })).toContain('2 more searches available');
		expect(await tool.execute({ query: 'b' })).toContain('1 more search available');
		expect(await tool.execute({ query: 'c' })).toContain('last search available');
	});

	it('passes a requested language through to the provider', async () => {
		const { search, langs } = stubSearch();
		const tool = webSearchTool(cfg(), { search });
		await tool.execute({ query: 'Bundestag', language: 'DE' });
		expect(langs).toEqual(['de']);
	});

	it('falls back to the configured default language, and lets a call override it', async () => {
		const { search, langs } = stubSearch();
		const tool = webSearchTool(cfg({ defaultLanguage: 'de' }), { search });
		await tool.execute({ query: 'a' });
		await tool.execute({ query: 'b', language: 'ja' });
		expect(langs).toEqual(['de', 'ja']);
	});

	it('drops a language it cannot validate rather than passing it on', async () => {
		// This value ends up in a provider's query string and comes from a model.
		const { search, langs } = stubSearch();
		const tool = webSearchTool(cfg(), { search });
		await tool.execute({ query: 'a', language: 'de&safesearch=off' });
		expect(langs).toEqual(['']);
	});

	it('keeps the same words in two languages as two searches', async () => {
		// Keyed on the query alone, the second call was served the first one's
		// results — the wrong language, reported as a cache hit.
		const { search } = stubSearch();
		const tool = webSearchTool(cfg(), { search });
		await tool.execute({ query: 'parliament', language: 'de' });
		const second = await tool.execute({ query: 'parliament', language: 'fr' });
		expect(search).toHaveBeenCalledTimes(2);
		expect(second).not.toContain('already searched');
	});

	it('still serves a repeat of the same query and language from memory', async () => {
		const { search } = stubSearch();
		const tool = webSearchTool(cfg(), { search });
		await tool.execute({ query: 'parliament', language: 'de' });
		expect(await tool.execute({ query: 'Parliament ', language: 'DE' })).toContain(
			'already searched'
		);
		expect(search).toHaveBeenCalledTimes(1);
	});

	it('reports the language and scope for the Observatory', async () => {
		const { search } = stubSearch();
		const tool = webSearchTool(cfg({ maxSearchesPerTurn: 5 }), { search, scope: 'leg' });
		const meta: Record<string, unknown>[] = [];
		await tool.execute({ query: 'a', language: 'ja' }, (m) => meta.push(m));
		expect(meta[0]).toMatchObject({
			language: 'ja',
			languageApplied: true,
			searchBudget: 5,
			scope: 'leg'
		});
	});

	it('says so when the provider cannot filter by language', async () => {
		// Tavily has no language parameter. Silence here reads as the tool having
		// ignored the request, so the model retries instead of trusting the words.
		const search = vi.fn(
			async (): Promise<SearchOutcome> => ({
				results: [result(1)],
				provider: 'tavily',
				language: 'de',
				languageApplied: false
			})
		);
		const tool = webSearchTool(cfg({ provider: 'tavily' }), { search });
		const out = await tool.execute({ query: 'Bundestag', language: 'de' });
		expect(out).toContain('cannot filter by language');
		expect(out).toContain('1. Title 1');
	});

	it('labels a call with its language in the run timeline', () => {
		const { search } = stubSearch();
		const tool = webSearchTool(cfg(), { search });
		expect(tool.describe?.({ query: 'Bundestag', language: 'de' })).toBe('Bundestag [de]');
		expect(tool.describe?.({ query: 'parliament' })).toBe('parliament');
	});
});

describe('normaliseLanguage', () => {
	it('accepts language and language-region tags, case-insensitively', () => {
		expect(normaliseLanguage('de')).toBe('de');
		expect(normaliseLanguage('DE')).toBe('de');
		expect(normaliseLanguage('pt-BR')).toBe('pt-br');
		expect(normaliseLanguage('pt_BR')).toBe('pt-br');
		expect(normaliseLanguage('  ja  ')).toBe('ja');
	});

	it('rejects anything that could ride into a provider query string', () => {
		for (const bad of [
			'de&safesearch=off',
			'de fr',
			'../../etc',
			'e',
			'englishlanguage',
			'',
			null,
			42,
			{ toString: () => 'de' }
		]) {
			expect(normaliseLanguage(bad), String(bad)).toBe('');
		}
	});
});

describe('ddgRegion', () => {
	it('flips a BCP-47 tag into DuckDuckGo region-language order', () => {
		expect(ddgRegion('de')).toBe('de-de');
		expect(ddgRegion('de-at')).toBe('at-de');
		expect(ddgRegion('fr')).toBe('fr-fr');
	});

	it('uses the table for the ones that do not derive', () => {
		// gb-en is not a thing; uk-en is.
		expect(ddgRegion('en-gb')).toBe('uk-en');
		expect(ddgRegion('pt-br')).toBe('br-pt');
		expect(ddgRegion('ja')).toBe('jp-jp');
		expect(ddgRegion('en')).toBe('us-en');
	});

	it('is empty for no language', () => {
		expect(ddgRegion('')).toBe('');
	});
});

describe('memoKey', () => {
	it('separates the same words in different languages', () => {
		expect(memoKey('parliament', 'de')).not.toBe(memoKey('parliament', 'fr'));
		expect(memoKey('  Parliament ', 'de')).toBe(memoKey('parliament', 'de'));
	});
});


describe('renderSnippetChars', () => {
	it('gives a short listing the full snippet', () => {
		// An admin who has deliberately narrowed maxResults should keep the detail;
		// the budget is there to stop a wide listing running away, not to punish a
		// narrow one.
		expect(renderSnippetChars(1)).toBe(240);
		expect(renderSnippetChars(5)).toBe(240);
	});

	it('shrinks the snippet as the listing widens, so the whole stays bounded', () => {
		// The listing is re-sent on every later round-trip of the turn, so what
		// matters is its total size, not any one row's.
		expect(renderSnippetChars(20)).toBe(100);
		expect(renderSnippetChars(20) * 20).toBeLessThanOrEqual(renderSnippetChars(5) * 5 * 1.7);
	});

	it('keeps a floor, so a very wide listing still says something per result', () => {
		expect(renderSnippetChars(200)).toBe(80);
	});

	it('does not divide by zero', () => {
		expect(renderSnippetChars(0)).toBe(240);
	});
});

describe('web_search result display', () => {
	const twenty = Array.from({ length: 20 }, (_, i) => result(i + 1));

	/** A result shaped like a real one: providers write long descriptions. */
	const realistic = (n: number): SearchResult => ({
		title: `Best Freight Forwarder China to New Zealand — Door-to-Door DDP ${n}`,
		url: `https://www.example-forwarder.com/services/lcl-consolidation/${n}`,
		snippet: `Door-to-door DDP shipping from China to New Zealand. ${'Consolidation, customs clearance and last-mile delivery. '.repeat(8)}`
	});

	it('renders twenty results for well under twice what five used to cost', () => {
		// The whole trade: the snippet is the expensive part of a result and the
		// least trustworthy, so it is what shrinks to pay for the extra fifteen
		// places to look.
		const five = formatSearchResults([1, 2, 3, 4, 5].map(realistic), 'q');
		const wide = formatSearchResults(
			Array.from({ length: 20 }, (_, i) => realistic(i + 1)),
			'q'
		);
		expect(wide.length / five.length).toBeLessThan(3);
		// Four times the results for well under three times the tokens.
		expect(wide.length / five.length).toBeGreaterThan(1);
	});

	it('reports rows for the box without putting them in the model text', () => {
		// Three audiences, three payloads: the model gets the return string, the
		// Observatory gets counts, the reader gets something to look at.
		const { search } = stubSearch(twenty);
		const tool = webSearchTool(cfg({ maxSearchesPerTurn: 5 }), { search });
		const meta: Record<string, unknown>[] = [];
		return tool.execute({ query: 'freight' }, (m) => meta.push(m)).then(() => {
			const display = meta[0].display as { results: { title: string; url: string }[] };
			expect(display.results).toHaveLength(20);
			expect(display.results[0]).toEqual({ title: 'Title 1', url: 'https://example.com/1' });
			expect(display.results[0]).not.toHaveProperty('snippet');
		});
	});

	it('replays the rows on a memo hit, so a repeat still draws its box', async () => {
		const { search } = stubSearch(twenty);
		const tool = webSearchTool(cfg(), { search });
		const meta: Record<string, unknown>[] = [];
		await tool.execute({ query: 'freight' }, (m) => meta.push(m));
		await tool.execute({ query: 'Freight ' }, (m) => meta.push(m));
		expect(search).toHaveBeenCalledTimes(1);
		expect(meta[1]).toMatchObject({ cached: true });
		expect((meta[1].display as { results: unknown[] }).results).toHaveLength(20);
	});

	it('names an untitled result rather than drawing a blank row', () => {
		const { search } = stubSearch([{ title: '  ', url: 'https://example.com/x', snippet: 's' }]);
		const tool = webSearchTool(cfg(), { search });
		const meta: Record<string, unknown>[] = [];
		return tool.execute({ query: 'a' }, (m) => meta.push(m)).then(() => {
			const display = meta[0].display as { results: { title: string }[] };
			expect(display.results[0].title).toBe('(untitled)');
		});
	});
});

describe('search pacing on the chat path', () => {
	it('leaves at least a second between searches on Brave', () => {
		// The requirement, asserted without sleeping for it: Brave's free tier is
		// metered per second, and this is the number the gate will wait out.
		expect(basePacing('brave').gapMs).toBeGreaterThanOrEqual(1000);
		expect(basePacing('brave').concurrency).toBe(1);
	});

	it('spaces searches out by whatever gap the pacer states', async () => {
		// Tool calls in a batch already run serially, so concurrency was never the
		// problem — the absence of any wait between them was.
		const gate = createGate({ pacing: { concurrency: 1, gapMs: 100, throttled: false }, observe: () => false });
		const started: number[] = [];
		for (let i = 0; i < 3; i++) {
			await gate();
			started.push(Date.now());
		}
		// A fifth of the gap as slack, because the marks are not the gate's own
		// clock: it starts waiting when it returns, and this samples a moment
		// later, so a loaded machine measures slightly *less* than it waited. At
		// a 5ms margin this failed intermittently under a full parallel run.
		expect(started[1] - started[0]).toBeGreaterThanOrEqual(80);
		expect(started[2] - started[1]).toBeGreaterThanOrEqual(80);
	});

	it('reads the pacer on every claim, so a mid-run throttle catches the rest', async () => {
		let gapMs = 0;
		const gate = createGate({
			get pacing() {
				return { concurrency: 1, gapMs, throttled: gapMs > 0 };
			},
			observe: () => false
		});
		await gate();
		gapMs = 60;
		const began = Date.now();
		await gate();
		expect(Date.now() - began).toBeGreaterThanOrEqual(55);
	});

	it('does not make a provider with no published limit wait', async () => {
		const gate = createGate(createPacer('searxng'));
		const began = Date.now();
		await gate();
		await gate();
		expect(Date.now() - began).toBeLessThan(200);
	});

	it('tightens after a provider says it is being asked too often', async () => {
		const pacer = createPacer('searxng');
		expect(pacer.pacing.throttled).toBe(false);
		const search = vi.fn(
			async (): Promise<SearchOutcome> => ({
				results: [result(1)],
				provider: 'searxng',
				degraded: { engines: ['brave (too many requests)'], reason: 'engines did not answer' }
			})
		);
		const tool = webSearchTool(cfg({ maxSearchesPerTurn: 3 }), { search, pacer });
		const meta: Record<string, unknown>[] = [];
		await tool.execute({ query: 'a' }, (m) => meta.push(m));
		expect(pacer.pacing.throttled).toBe(true);
		// Reported so a throttled run is legible in the Observatory rather than
		// just mysteriously slow.
		expect(meta[0]).toMatchObject({ pacing: 'throttled' });
	});

	it('feeds a failed search back to the pacer before the next one starts', async () => {
		// A refusal is the clearest signal there is about how hard we are pushing,
		// and it arrives as a thrown error rather than a degraded result.
		const pacer = createPacer('searxng');
		const search = vi.fn(async () => {
			throw new Error('rejected: too many requests');
		});
		const tool = webSearchTool(cfg(), { search, pacer });
		await expect(tool.execute({ query: 'a' })).rejects.toThrow(/too many requests/);
		expect(pacer.pacing.throttled).toBe(true);
	});
});
