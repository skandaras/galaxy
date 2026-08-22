import { describe, it, expect, vi, afterEach } from 'vitest';
import {
	SearchProviderError,
	assertLooksLikeDuckDuckGoResults,
	basePacing,
	createPacer,
	formatSearchResults,
	isRateLimitReason,
	nextPacing,
	parseDuckDuckGoHtml,
	parseUnresponsiveEngines,
	runPaced,
	runWebSearch,
	type Pacing
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

	it('sends a regional tag to Brave whole, rather than in pieces', async () => {
		// This used to be split into `search_lang=pt` + `country=BR`, and Brave
		// takes neither half — `pt-br` is one of its values, and bare `pt` is not.
		const calls = captureFetch({ web: { results: [] } });
		await runWebSearch('camara', cfg({ provider: 'brave', apiKeyEnc: undefined }), 'pt-br');
		expect(calls[0].url).toContain('search_lang=pt-br');
		expect(calls[0].url).not.toContain('country=');
	});

	it('sends only search_lang for a bare language', async () => {
		const calls = captureFetch({ web: { results: [] } });
		await runWebSearch('Bundestag', cfg({ provider: 'brave' }), 'de');
		expect(calls[0].url).toContain('search_lang=de');
		expect(calls[0].url).not.toContain('country=');
	});

	it("uses Brave's own names for the languages that have their own names", async () => {
		// The failure that started this: every `[zh]` query came back empty because
		// Brave has no bare `zh`, and answers an unlisted value with a 422.
		const url = async (lang: string) => {
			const calls = captureFetch({ web: { results: [] } });
			await runWebSearch('x', cfg({ provider: 'brave' }), lang);
			return calls[0].url;
		};
		expect(await url('zh')).toContain('search_lang=zh-hans');
		expect(await url('zh-cn')).toContain('search_lang=zh-hans');
		expect(await url('zh-tw')).toContain('search_lang=zh-hant');
		expect(await url('zh-hant')).toContain('search_lang=zh-hant');
		expect(await url('ja')).toContain('search_lang=jp');
		expect(await url('pt')).toContain('search_lang=pt-pt');
		expect(await url('en-gb')).toContain('search_lang=en-gb');
	});

	it('falls back to the base language when the region has no Brave value', async () => {
		const calls = captureFetch({ web: { results: [] } });
		await runWebSearch('x', cfg({ provider: 'brave' }), 'de-at');
		expect(calls[0].url).toContain('search_lang=de');
	});

	it('omits the parameter, and says so, for a language Brave cannot express', async () => {
		// Sending it anyway is a 422 and an empty round; the model needs to know
		// the results are unfiltered rather than that nothing exists.
		const calls = captureFetch({ web: { results: [] } });
		const outcome = await runWebSearch('x', cfg({ provider: 'brave' }), 'cy');
		expect(calls[0].url).not.toContain('search_lang=');
		expect(outcome.language).toBe('cy');
		expect(outcome.languageApplied).toBe(false);
	});

	it('reports that Brave applied a language it does support', async () => {
		captureFetch({ web: { results: [] } });
		const outcome = await runWebSearch('x', cfg({ provider: 'brave' }), 'zh');
		expect(outcome.languageApplied).toBe(true);
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

/**
 * Pacing exists because the engines told us so: `too many requests` from Brave,
 * `CAPTCHA` from DuckDuckGo and Startpage, all in one response, from a round
 * that fired three queries at once across six engines. These cover the two
 * halves — knowing which refusals mean "slow down", and actually slowing down.
 */
describe('isRateLimitReason', () => {
	it.each([
		'too many requests',
		'Too Many Requests',
		'unusual traffic from your computer network',
		'CAPTCHA',
		'HTTP 429',
		'rate limited',
		'rate-limit exceeded',
		'quota exceeded',
		'throttled'
	])('treats %j as being asked too often', (reason) => {
		expect(isRateLimitReason(reason)).toBe(true);
	});

	it.each(['DNS error', 'timeout', 'parsing error', 'connection refused', ''])(
		'treats %j as a broken engine, not a fast one',
		(reason) => {
			// Slowing down would make the run longer and fix nothing.
			expect(isRateLimitReason(reason)).toBe(false);
		}
	);

	it('ignores anything that is not a string', () => {
		expect(isRateLimitReason(undefined)).toBe(false);
		expect(isRateLimitReason(429)).toBe(false);
	});

	it('does not fire on a number that merely contains 429', () => {
		expect(isRateLimitReason('took 1429ms')).toBe(false);
	});
});

describe('basePacing', () => {
	it('starts Brave serial with a gap, before anything has failed', () => {
		// Brave's free tier is metered per second; discovering that by tripping it
		// spends searches the run needed.
		const pacing = basePacing('brave');
		expect(pacing.concurrency).toBe(1);
		expect(pacing.gapMs).toBeGreaterThan(0);
		expect(pacing.throttled).toBe(false);
	});

	it.each(['searxng', 'duckduckgo', 'tavily'] as const)(
		'lets %s run at the configured concurrency with no gap',
		(provider) => {
			const pacing = basePacing(provider);
			expect(pacing.concurrency).toBeGreaterThan(1);
			expect(pacing.gapMs).toBe(0);
			expect(pacing.throttled).toBe(false);
		}
	);
});

describe('nextPacing', () => {
	const fast: Pacing = { concurrency: 3, gapMs: 0, throttled: false };

	it('drops to serial with a gap when something says we are asking too often', () => {
		const tightened = nextPacing(fast, true);
		expect(tightened.concurrency).toBe(1);
		expect(tightened.gapMs).toBeGreaterThan(0);
		expect(tightened.throttled).toBe(true);
	});

	it('leaves pacing alone when nothing was rate limited', () => {
		expect(nextPacing(fast, false)).toBe(fast);
	});

	it('stays throttled once throttled', () => {
		// One-way on purpose: SearXNG benches a blocked engine for minutes to an
		// hour, so a quiet search is not evidence the block has lifted.
		const tightened = nextPacing(fast, true);
		expect(nextPacing(tightened, false)).toBe(tightened);
		expect(nextPacing(tightened, true)).toBe(tightened);
	});
});

describe('createPacer', () => {
	it('reports throttling engaging exactly once', () => {
		const pacer = createPacer('searxng');
		expect(pacer.observe(['duckduckgo (DNS error)'])).toBe(false);
		expect(pacer.pacing.throttled).toBe(false);
		expect(pacer.observe(['brave (too many requests)'])).toBe(true);
		expect(pacer.observe(['duckduckgo (CAPTCHA)'])).toBe(false);
		expect(pacer.pacing.throttled).toBe(true);
	});

	it('reads a provider error string as well as engine names', () => {
		const pacer = createPacer('searxng');
		expect(pacer.observe(['SearchProviderError: brave returned HTTP 429'])).toBe(true);
	});
});

describe('runPaced', () => {
	const pacerAt = (pacing: Pacing) => {
		let current = pacing;
		return {
			get pacing() {
				return current;
			},
			observe(reasons: readonly unknown[]) {
				const next = nextPacing(current, reasons.some(isRateLimitReason));
				const engaged = next.throttled && !current.throttled;
				current = next;
				return engaged;
			}
		};
	};

	it('never exceeds its concurrency', async () => {
		let live = 0;
		let peak = 0;
		await runPaced([1, 2, 3, 4, 5, 6], pacerAt({ concurrency: 2, gapMs: 0, throttled: false }), async (n) => {
			peak = Math.max(peak, ++live);
			await new Promise((r) => setTimeout(r, 5));
			live--;
			return n;
		});
		expect(peak).toBe(2);
	});

	it('returns results in item order however they finish', async () => {
		const out = await runPaced(
			[30, 5, 15],
			pacerAt({ concurrency: 3, gapMs: 0, throttled: false }),
			async (ms) => {
				await new Promise((r) => setTimeout(r, ms));
				return ms;
			}
		);
		expect(out).toEqual([30, 5, 15]);
	});

	it('spaces starts by the gap', async () => {
		const starts: number[] = [];
		await runPaced([1, 2, 3], pacerAt({ concurrency: 1, gapMs: 20, throttled: false }), async () => {
			starts.push(Date.now());
		});
		expect(starts).toHaveLength(3);
		// Timers overshoot rather than undershoot, so assert the floor with slack.
		expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(15);
		expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(15);
	});

	it('lets one failing item thin the round rather than sink it', async () => {
		const out = await runPaced(
			[1, 2, 3],
			pacerAt({ concurrency: 2, gapMs: 0, throttled: false }),
			async (n) => {
				if (n === 2) throw new Error('boom');
				return n;
			}
		);
		expect(out).toEqual([1, undefined, 3]);
	});

	it('tightens queries still queued behind one that hit a rate limit', async () => {
		// The point of reading the pacer per claim: the first search's refusal has
		// to reach the four still waiting, not just the next round.
		process.env.SEARCH_THROTTLED_GAP_MS = '5'; // the real 2s would be a slow test
		const pacer = pacerAt({ concurrency: 3, gapMs: 0, throttled: false });
		let live = 0;
		const peaks: number[] = [];
		await runPaced([1, 2, 3, 4, 5, 6], pacer, async (n) => {
			live++;
			peaks.push(live);
			if (n === 1) pacer.observe(['brave (too many requests)']);
			await new Promise((r) => setTimeout(r, 5));
			live--;
			return n;
		});
		expect(pacer.pacing.concurrency).toBe(1);
		// The last items ran alone, whatever the first three did.
		expect(peaks.slice(-2)).toEqual([1, 1]);
		delete process.env.SEARCH_THROTTLED_GAP_MS;
	});

	it('does nothing at all for an empty round', async () => {
		const task = vi.fn();
		expect(await runPaced([], pacerAt({ concurrency: 3, gapMs: 0, throttled: false }), task)).toEqual(
			[]
		);
		expect(task).not.toHaveBeenCalled();
	});
});


describe('a language the provider rejects', () => {
	afterEach(() => vi.unstubAllGlobals());

	const cfg = (over: Partial<WebSearchSettings> = {}): WebSearchSettings => ({
		...DEFAULT_WEB_SEARCH,
		provider: 'brave',
		apiKeyEnc: undefined,
		...over
	});

	/** Answer 422 while `search_lang` is present, and normally once it is gone. */
	function braveRejectingLanguage() {
		const calls: string[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string) => {
				calls.push(url);
				if (url.includes('search_lang=')) {
					return new Response("Input should be 'ar', 'eu', … 'zh-hans', 'zh-hant'", {
						status: 422
					});
				}
				return new Response(
					JSON.stringify({ web: { results: [{ title: 'T', url: 'https://e.com', description: 'd' }] } }),
					{ status: 200, headers: { 'content-type': 'application/json' } }
				);
			})
		);
		return calls;
	}

	it('asks again without it rather than losing the query', async () => {
		// providerLanguage already declines a tag Brave has no value for; this is
		// for the case it cannot know about — an allowlist that has moved.
		const calls = braveRejectingLanguage();
		const outcome = await runWebSearch('x', cfg({ provider: 'brave' }), 'de');
		expect(outcome.results).toHaveLength(1);
		expect(calls).toHaveLength(2);
		expect(calls[1]).not.toContain('search_lang=');
	});

	it('tells the caller the results are unfiltered', async () => {
		braveRejectingLanguage();
		const outcome = await runWebSearch('x', cfg({ provider: 'brave' }), 'de');
		expect(outcome.language).toBe('de');
		expect(outcome.languageApplied).toBe(false);
	});

	it('does not retry a failure that is not a refusal', async () => {
		// A 5xx or a rate limit is not the language's fault, and retrying without
		// it would just spend a second request to fail the same way.
		const calls: string[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string) => {
				calls.push(url);
				return new Response('upstream is down', { status: 503 });
			})
		);
		await expect(
			runWebSearch('x', cfg({ provider: 'brave', fallbackProvider: 'none' }), 'de')
		).rejects.toThrow(/brave/);
		expect(calls).toHaveLength(1);
	});

	it('treats a body with no web results object as a failure, not an empty answer', async () => {
		// `data.web?.results ?? []` turned any unexpected shape into a clean zero,
		// which reads to the model as "nothing exists".
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response(JSON.stringify({ query: { original: 'x' } }), {
						status: 200,
						headers: { 'content-type': 'application/json' }
					})
			)
		);
		await expect(
			runWebSearch('x', cfg({ provider: 'brave', fallbackProvider: 'none' }))
		).rejects.toThrow(/no web results object/);
	});
});
