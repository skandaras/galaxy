import { describe, expect, it, vi } from 'vitest';
import type { WebSearchSettings } from '$lib/server/settings';
import {
	formatSearchResults,
	normaliseQuery,
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
	const search = vi.fn(async (query: string): Promise<SearchOutcome> => {
		calls.push(query);
		return { results, provider: 'searxng' };
	});
	return { search, calls };
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
});
