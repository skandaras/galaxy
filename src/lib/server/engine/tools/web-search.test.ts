import { describe, it, expect, vi, afterEach } from 'vitest';
import {
	SearchProviderError,
	assertLooksLikeDuckDuckGoResults,
	formatSearchResults,
	parseDuckDuckGoHtml,
	parseUnresponsiveEngines,
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

describe('runWebSearch language', () => {
	afterEach(() => vi.unstubAllGlobals());

	const cfg = (over: Partial<WebSearchSettings>): WebSearchSettings => ({
		...DEFAULT_WEB_SEARCH,
		...over
	});

	/** Capture the URL and init the provider was called with. */
	function captureFetch(body: unknown) {
		const calls: { url: string; init: RequestInit | undefined }[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string, init?: RequestInit) => {
				calls.push({ url: String(url), init });
				return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
					status: 200,
					headers: {
						'content-type': typeof body === 'string' ? 'text/html' : 'application/json'
					}
				});
			})
		);
		return calls;
	}

	it('sends SearXNG its language parameter', async () => {
		const calls = captureFetch({ results: [] });
		await runWebSearch('Bundestag', cfg({ provider: 'searxng', baseUrl: 'http://s:8080' }), 'de');
		expect(calls[0].url).toContain('&language=de');
	});

	it('splits a region tag into Brave search_lang and country', async () => {
		const calls = captureFetch({ web: { results: [] } });
		await runWebSearch('camara', cfg({ provider: 'brave', apiKeyEnc: undefined }), 'pt-br');
		expect(calls[0].url).toContain('search_lang=pt');
		expect(calls[0].url).toContain('country=BR');
	});

	it('sends only search_lang for a bare language', async () => {
		const calls = captureFetch({ web: { results: [] } });
		await runWebSearch('Bundestag', cfg({ provider: 'brave' }), 'de');
		expect(calls[0].url).toContain('search_lang=de');
		expect(calls[0].url).not.toContain('country=');
	});

	it("puts DuckDuckGo's region-language pair in the form body", async () => {
		const calls = captureFetch(RESULTS_PAGE);
		await runWebSearch('Bundestag', cfg({ provider: 'duckduckgo' }), 'de');
		expect(String(calls[0].init?.body)).toContain('kl=de-de');
	});

	it('omits the parameter entirely when no language is asked for', async () => {
		const calls = captureFetch({ results: [] });
		await runWebSearch('anything', cfg({ provider: 'searxng', baseUrl: 'http://s:8080' }));
		expect(calls[0].url).not.toContain('language=');
	});

	it('applies the configured default when a call names no language', async () => {
		const calls = captureFetch({ results: [] });
		await runWebSearch(
			'anything',
			cfg({ provider: 'searxng', baseUrl: 'http://s:8080', defaultLanguage: 'ja' })
		);
		expect(calls[0].url).toContain('&language=ja');
	});

	it('reports that Tavily could not apply the language', async () => {
		// Tavily's API has no language parameter; the outcome has to say so, or
		// off-language results look like the tool ignoring the request.
		captureFetch({ results: [] });
		const outcome = await runWebSearch('Bundestag', cfg({ provider: 'tavily' }), 'de');
		expect(outcome.language).toBe('de');
		expect(outcome.languageApplied).toBe(false);
	});

	it('reports it applied for a provider that can', async () => {
		captureFetch({ results: [] });
		const outcome = await runWebSearch(
			'Bundestag',
			cfg({ provider: 'searxng', baseUrl: 'http://s:8080' }),
			'de'
		);
		expect(outcome.languageApplied).toBe(true);
	});

	it('never lets an unvalidated language reach the query string', async () => {
		const calls = captureFetch({ results: [] });
		await runWebSearch(
			'x',
			cfg({ provider: 'searxng', baseUrl: 'http://s:8080' }),
			'de&safesearch=off'
		);
		expect(calls[0].url).not.toContain('safesearch');
		expect(calls[0].url).not.toContain('language=');
	});
});

/**
 * SearXNG answers HTTP 200 with an empty result list whether the query found
 * nothing or every engine failed — and says which in `unresponsive_engines`.
 *
 * Every pre-existing SearXNG test here stubbed `{ results: [] }` and asserted
 * only on the request URL, so all of them passed while a completely dead
 * instance was being reported to the model as "there is simply nothing indexed
 * for these terms". These cover the difference.
 */
describe('SearXNG engine health', () => {
	afterEach(() => vi.unstubAllGlobals());

	const cfg = (over: Partial<WebSearchSettings> = {}): WebSearchSettings => ({
		...DEFAULT_WEB_SEARCH,
		provider: 'searxng',
		baseUrl: 'http://s:8080',
		...over
	});

	/** Reply to the SearXNG host with `body`, and to anything else with `other`. */
	function stub(body: unknown, other?: string) {
		const calls: string[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string) => {
				calls.push(String(url));
				const searx = String(url).includes('s:8080');
				return searx || other === undefined
					? new Response(JSON.stringify(body), {
							status: 200,
							headers: { 'content-type': 'application/json' }
						})
					: new Response(other, { status: 200, headers: { 'content-type': 'text/html' } });
			})
		);
		return calls;
	}

	const DOWN = {
		results: [],
		unresponsive_engines: [
			['duckduckgo', 'DNS error'],
			['brave', 'CAPTCHA']
		]
	};
	const SOME = {
		results: [{ title: 'One', url: 'https://example.com/1', content: 'A snippet.' }],
		unresponsive_engines: [['brave', 'timeout']]
	};

	it('treats every engine failing as a provider failure, not an empty answer', async () => {
		stub(DOWN);
		await expect(runWebSearch('anything', cfg({ fallbackProvider: 'none' }))).rejects.toThrow(
			SearchProviderError
		);
	});

	it('names the engines and how to check the instance', async () => {
		stub(DOWN);
		await runWebSearch('anything', cfg({ fallbackProvider: 'none' })).catch((err) => {
			expect(err.reason).toContain('duckduckgo (DNS error)');
			expect(err.reason).toContain('brave (CAPTCHA)');
			expect(err.reason).toMatch(/reach the internet/);
		});
		expect.assertions(3);
	});

	it('finally lets the fallback provider do its job', async () => {
		// The whole point: a 200-with-nothing returned normally, so the catch
		// that drives failover never ran and the configured fallback was inert
		// for exactly the failure being hit.
		stub(DOWN, RESULTS_PAGE);
		const outcome = await runWebSearch('anything', cfg({ fallbackProvider: 'duckduckgo' }));
		expect(outcome.provider).toBe('duckduckgo');
		expect(outcome.results.length).toBeGreaterThan(0);
		expect(outcome.failedOver?.from).toBe('searxng');
	});

	it('returns partial results rather than failing when some engines answered', async () => {
		stub(SOME);
		const outcome = await runWebSearch('anything', cfg());
		expect(outcome.results).toHaveLength(1);
		expect(outcome.degraded?.engines).toEqual(['brave (timeout)']);
	});

	it('leaves a genuinely empty answer alone', async () => {
		// No unresponsive engines: the search worked and the web has nothing.
		stub({ results: [], unresponsive_engines: [] });
		const outcome = await runWebSearch('anything', cfg());
		expect(outcome.results).toEqual([]);
		expect(outcome.degraded).toBeUndefined();
	});

	it('copes with an instance that reports engines as bare names', async () => {
		stub({ results: [], unresponsive_engines: ['duckduckgo'] });
		await expect(runWebSearch('x', cfg({ fallbackProvider: 'none' }))).rejects.toThrow(
			/duckduckgo/
		);
	});
});

describe('parseUnresponsiveEngines', () => {
	it('renders engine and reason pairs', () => {
		expect(
			parseUnresponsiveEngines([
				['duckduckgo', 'DNS error'],
				['brave', 'CAPTCHA']
			])
		).toEqual(['duckduckgo (DNS error)', 'brave (CAPTCHA)']);
	});

	it('accepts a bare engine name', () => {
		expect(parseUnresponsiveEngines(['mojeek'])).toEqual(['mojeek']);
	});

	it('ignores anything that is not an engine', () => {
		expect(parseUnresponsiveEngines([[], [''], [null, 'x'], 7, null])).toEqual([]);
	});

	it('is empty for a body that carries no such field', () => {
		expect(parseUnresponsiveEngines(undefined)).toEqual([]);
		expect(parseUnresponsiveEngines('nonsense')).toEqual([]);
	});
});

describe('what the model is told about an empty search', () => {
	it('claims the search worked only when it demonstrably did', () => {
		const clean = formatSearchResults([], 'board game reviewers', { provider: 'searxng' });
		expect(clean).toContain('The search worked');
		expect(clean).toContain('Do not repeat this query');
	});

	it('says a degraded search failed, and does not forbid a retry', () => {
		// The reported defect: an instance whose engines were all down told the
		// model there was "simply nothing indexed for these terms", and not to
		// try again.
		const broken = formatSearchResults([], 'board game reviewers', {
			provider: 'searxng',
			degraded: { engines: ['duckduckgo (DNS error)'], reason: 'engines did not answer' }
		});
		expect(broken).not.toContain('The search worked');
		expect(broken).not.toContain('Do not repeat this query');
		expect(broken).toContain('duckduckgo (DNS error)');
		expect(broken).toMatch(/tooling failure/);
	});

	it('marks partial results as partial', () => {
		const partial = formatSearchResults(
			[{ title: 'One', url: 'https://example.com/1', snippet: 'x' }],
			'q',
			{
				provider: 'searxng',
				degraded: { engines: ['brave (timeout)'], reason: 'engines did not answer' }
			}
		);
		expect(partial).toContain('brave (timeout)');
		expect(partial).toContain('incomplete');
		expect(partial).toContain('example.com/1');
	});
});
