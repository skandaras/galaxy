import { describe, it, expect, vi, afterEach } from 'vitest';
import {
	SearchProviderError,
	assertLooksLikeDuckDuckGoResults,
	parseDuckDuckGoHtml,
	runWebSearch
} from './web-search';
import { DEFAULT_WEB_SEARCH, type WebSearchSettings } from '$lib/server/settings';

const RESULTS_PAGE = `
	<div id="links" class="results">
		<div class="result">
			<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fone&rut=abc">First <b>Result</b></a>
			<a class="result__snippet" href="x">A snippet about &amp; things.</a>
		</div>
		<div class="result">
			<a class="result__a" href="https://direct.example.org/two">Second Result</a>
			<a class="result__snippet" href="y">Second snippet.</a>
		</div>
	</div>`;

describe('parseDuckDuckGoHtml', () => {
	it('extracts titles, unwrapped urls and snippets', () => {
		const results = parseDuckDuckGoHtml(RESULTS_PAGE, 10);
		expect(results).toHaveLength(2);
		expect(results[0]).toEqual({
			title: 'First Result',
			url: 'https://example.com/one',
			snippet: 'A snippet about & things.'
		});
		expect(results[1].url).toBe('https://direct.example.org/two');
	});

	it('respects the max results cap', () => {
		expect(parseDuckDuckGoHtml(RESULTS_PAGE, 1)).toHaveLength(1);
	});
});

describe('assertLooksLikeDuckDuckGoResults', () => {
	// The bug this guards: DuckDuckGo answers a blocked request with HTTP 200
	// and a bot-check page, which used to parse to [] and be reported to the
	// model as "no results found".
	it('throws on a bot-check page served with status 200', () => {
		const blocked = `<html><body><h1>Unfortunately, bots use DuckDuckGo too.</h1>
			<p>Please try again later. anomaly detected.</p></body></html>`;
		expect(() => assertLooksLikeDuckDuckGoResults(blocked, 200)).toThrow(SearchProviderError);
		try {
			assertLooksLikeDuckDuckGoResults(blocked, 200);
		} catch (e) {
			const err = e as SearchProviderError;
			expect(err.provider).toBe('duckduckgo');
			expect(err.reason).toMatch(/blocked by DuckDuckGo/);
			expect(err.status).toBe(200);
			expect(err.bytes).toBe(blocked.length);
		}
	});

	it('throws on an unrecognised page rather than reporting no results', () => {
		expect(() => assertLooksLikeDuckDuckGoResults('<html><body>hello</body></html>', 200)).toThrow(
			/no recognisable results markup/
		);
	});

	it('accepts a genuine results page', () => {
		expect(() => assertLooksLikeDuckDuckGoResults(RESULTS_PAGE, 200)).not.toThrow();
	});

	it('accepts a valid page that legitimately has zero results', () => {
		// A real "no results" answer must stay an empty list, not an error.
		const empty = '<div id="links" class="results"><div class="no-results">No results.</div></div>';
		expect(() => assertLooksLikeDuckDuckGoResults(empty, 200)).not.toThrow();
		expect(parseDuckDuckGoHtml(empty, 10)).toEqual([]);
	});
});

describe('SearchProviderError', () => {
	it('reports provider, reason and status in its message', () => {
		const err = new SearchProviderError('searxng', 'expected JSON, got HTML', 403, 120);
		expect(err.message).toContain('searxng');
		expect(err.message).toContain('expected JSON, got HTML');
		expect(err.message).toContain('403');
	});
});

describe('runWebSearch failover', () => {
	afterEach(() => vi.unstubAllGlobals());

	const html = (body: string, status = 200) =>
		new Response(body, { status, headers: { 'content-type': 'text/html' } });
	const jsonRes = (obj: unknown) =>
		new Response(JSON.stringify(obj), {
			status: 200,
			headers: { 'content-type': 'application/json' }
		});

	const cfg = (over: Partial<WebSearchSettings>): WebSearchSettings => ({
		...DEFAULT_WEB_SEARCH,
		...over
	});

	it('falls back to the secondary provider when the primary is blocked', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string) =>
				String(url).includes('duckduckgo')
					? html(RESULTS_PAGE)
					: html('<html><body>anomaly detected</body></html>')
			)
		);
		const outcome = await runWebSearch('anything', {
			...cfg({ provider: 'searxng', baseUrl: 'http://searxng:8080' }),
			fallbackProvider: 'duckduckgo'
		});
		expect(outcome.provider).toBe('duckduckgo');
		expect(outcome.results).toHaveLength(2);
		expect(outcome.failedOver?.from).toBe('searxng');
	});

	it('does NOT fall back when the primary legitimately finds nothing', async () => {
		const fetchMock = vi.fn(async () => jsonRes({ results: [] }));
		vi.stubGlobal('fetch', fetchMock);
		const outcome = await runWebSearch('obscure', {
			...cfg({ provider: 'searxng', baseUrl: 'http://searxng:8080' }),
			fallbackProvider: 'duckduckgo'
		});
		expect(outcome.results).toEqual([]);
		expect(outcome.provider).toBe('searxng');
		expect(outcome.failedOver).toBeUndefined();
		// An empty answer must cost exactly one request — no pointless retry.
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('propagates the primary error when no fallback is configured', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => html('<html>anomaly</html>')));
		await expect(
			runWebSearch('x', cfg({ provider: 'duckduckgo', fallbackProvider: 'none' }))
		).rejects.toThrow(SearchProviderError);
	});
});
