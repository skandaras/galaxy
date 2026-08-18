import { describe, it, expect } from 'vitest';
import type { ModelChoice } from '$lib/server/providers/registry';
import type { CompletionResult } from '$lib/server/providers/types';
import { RESEARCH_EFFORTS, resolveEffort } from '$lib/research-effort';
import {
	DEFAULT_RESEARCH,
	RESEARCH_ROUNDS_MAX,
	normaliseResearchSettings,
	researchRoundCeiling
} from '$lib/server/settings';
import {
	EMPTY_BRIEF,
	PAGE_TEXT_CHARS,
	assertPublicHttpUrl,
	briefToPrompt,
	canonicalUrlKey,
	clipExcerpt,
	clipPage,
	consolidate,
	dedupeQueries,
	evidenceExcerptBudget,
	extractReadableHtml,
	fetchPageText,
	frameQuestion,
	framingHistory,
	gapQueries,
	htmlToReadableText,
	htmlToText,
	mergeBrief,
	parseBrief,
	parseQueries,
	parseTriagePicks,
	planQueries,
	readPages,
	registrableDomain,
	roundBudget,
	shouldStopAfterRound,
	classifyFetchError,
	countFailures,
	decodeBody,
	isRetryableFetch,
	jsonLdText,
	safeFetch,
	sourceRegister,
	sourcesFooter,
	PageFetchError,
	triagePages,
	triageResults,
	type Evidence,
	type ResearchBrief
} from './research';
import type { StoredMessage } from '$lib/server/chats';
import type { SearchResult } from './tools/web-search';

/** Adapter whose complete() is scripted per call. */
function choiceOf(...replies: CompletionResult[]): ModelChoice {
	let i = 0;
	return {
		model: { modelKey: 'm' },
		provider: {},
		adapter: {
			complete: async () => replies[Math.min(i++, replies.length - 1)],
			stream: async function* () {},
			listModels: async () => []
		}
	} as unknown as ModelChoice;
}

const ok = (text: string): CompletionResult => ({ text, usage: null, finishReason: 'stop' });
const reasonedOut: CompletionResult = {
	text: '',
	usage: null,
	finishReason: 'length',
	reasonedOnly: true
};

/** Capture the last user prompt an adapter was handed. */
function spyOn(choice: ModelChoice): () => string {
	let prompt = '';
	const inner = choice.adapter.complete;
	choice.adapter.complete = ((req: { messages: { content: string }[] }, signal: AbortSignal) => {
		prompt = req.messages[req.messages.length - 1].content;
		return inner(req as never, signal);
	}) as typeof inner;
	return () => prompt;
}

const source = (n: number, excerpt = `body of ${n}`): Evidence => ({
	n,
	title: `Source ${n}`,
	url: `https://example.com/${n}`,
	excerpt,
	kind: 'page'
});

/** A source whose page could not be read, so only the search snippet survived. */
const snippetSource = (n: number, excerpt = `snippet for ${n}`): Evidence => ({
	...source(n, excerpt),
	kind: 'snippet'
});

const briefOf = (over: Partial<ResearchBrief> = {}): ResearchBrief => ({
	...EMPTY_BRIEF,
	round: 1,
	...over
});

describe('assertPublicHttpUrl', () => {
	it('blocks loopback, private and link-local targets', () => {
		for (const bad of [
			'http://127.0.0.1/x',
			'http://localhost/x',
			'http://10.0.0.5/x',
			'http://192.168.1.1/x',
			'http://172.18.0.2/x',
			'http://169.254.169.254/latest/meta-data',
			'http://docker.internal/x',
			'http://nas.local/x',
			'file:///etc/passwd'
		]) {
			expect(() => assertPublicHttpUrl(bad), bad).toThrow(/Blocked/);
		}
	});
	it('allows normal public urls', () => {
		expect(() => assertPublicHttpUrl('https://example.com/page')).not.toThrow();
		expect(() => assertPublicHttpUrl('http://93.184.216.34/x')).not.toThrow();
	});
});

describe('htmlToText', () => {
	it('strips scripts, styles and tags, keeps content', () => {
		const html =
			'<html><head><style>body{color:red}</style></head><body><script>var x=1;</script><h1>Title</h1><p>Hello &amp; welcome.</p><div>Line two</div></body></html>';
		const text = htmlToText(html);
		expect(text).toContain('Title');
		expect(text).toContain('Hello & welcome.');
		expect(text).toContain('Line two');
		expect(text).not.toContain('var x');
		expect(text).not.toContain('color:red');
		expect(text).not.toContain('<');
	});

	it('preserves paragraph breaks', () => {
		const lines = htmlToText('<p>a</p><p>b</p>')
			.split('\n')
			.map((l) => l.trim());
		expect(lines).toEqual(['a', 'b']);
	});
});

describe('planQueries', () => {
	const cfg = { ...DEFAULT_RESEARCH, maxQueries: 4 };

	it('uses the planned queries when the model returns JSON', async () => {
		const out = await planQueries(
			choiceOf(ok('{"queries":["a","b"]}')),
			'',
			'question?',
			cfg,
			() => {}
		);
		expect(out).toEqual({
			queries: [
				{ q: 'a', language: '' },
				{ q: 'b', language: '' }
			],
			fellBack: null,
			reasonedOnly: false
		});
	});

	it('retries with more room when the model spent its budget reasoning', async () => {
		// The first call comes back empty and stopped on length; the retry is what
		// turns "1 query — the raw question" back into a real plan.
		const out = await planQueries(
			choiceOf(reasonedOut, ok('{"queries":["x","y","z"]}')),
			'',
			'question?',
			cfg,
			() => {}
		);
		expect(out.queries.map((q) => q.q)).toEqual(['x', 'y', 'z']);
		expect(out.fellBack).toBeNull();
	});

	it('reports the fallback rather than silently searching the question', async () => {
		const out = await planQueries(choiceOf(reasonedOut), '', 'question?', cfg, () => {});
		expect(out.queries).toEqual([{ q: 'question?', language: '' }]);
		expect(out.fellBack).toBe('empty');
		expect(out.reasonedOnly).toBe(true);
	});

	it('flags unparseable output separately from an empty one', async () => {
		const out = await planQueries(choiceOf(ok('sure! here you go')), '', 'question?', cfg, () => {});
		expect(out.queries).toEqual([{ q: 'question?', language: '' }]);
		expect(out.fellBack).toBe('unparseable');
	});

	it('counts tokens from both attempts', async () => {
		const usage = { promptTokens: 5, completionTokens: 7 };
		let total = 0;
		await planQueries(
			choiceOf({ ...reasonedOut, usage }, { ...ok('{"queries":["a"]}'), usage }),
			'',
			'q?',
			cfg,
			(u) => {
				total += u?.completionTokens ?? 0;
			}
		);
		expect(total).toBe(14);
	});

	it('carries the language the planner tagged each query with', async () => {
		const out = await planQueries(
			choiceOf(
				ok('{"queries":[{"q":"Bundestag Sitzung","language":"de"},{"q":"german parliament","language":""}]}')
			),
			'',
			'question?',
			cfg,
			() => {}
		);
		expect(out.queries).toEqual([
			{ q: 'Bundestag Sitzung', language: 'de' },
			{ q: 'german parliament', language: '' }
		]);
	});

	it('asks the planner to search in the language of the sources', async () => {
		const choice = choiceOf(ok('{"queries":["a"]}'));
		const prompt = spyOn(choice);
		await planQueries(choice, '', 'Was ist das Bundesverfassungsgericht?', cfg, () => {});
		expect(prompt()).toMatch(/local language/i);
		expect(prompt()).toContain('"language"');
	});

	it('names the admin-configured extra languages in the brief', async () => {
		const choice = choiceOf(ok('{"queries":["a"]}'));
		const prompt = spyOn(choice);
		await planQueries(
			choice,
			'',
			'q?',
			{ ...cfg, extraLanguages: 'de, ja, not-a-language!' },
			() => {}
		);
		expect(prompt()).toContain('de, ja');
		expect(prompt()).not.toContain('not-a-language!');
	});

	it('honours a per-request query cap below the admin ceiling', async () => {
		// Effort scales the planner's breadth, not just the round count.
		const choice = choiceOf(ok('{"queries":["a","b","c","d"]}'));
		const prompt = spyOn(choice);
		const out = await planQueries(choice, '', 'q?', cfg, () => {}, '', { maxQueries: 2 });
		expect(prompt()).toContain('up to 2 focused web-search queries');
		expect(out.queries.map((q) => q.q)).toEqual(['a', 'b']);
	});
});

describe('parseQueries', () => {
	it('accepts the tagged shape it asks for', () => {
		expect(parseQueries('{"queries":[{"q":"a","language":"DE"}]}', 4)).toEqual([
			{ q: 'a', language: 'de' }
		]);
	});

	it('still accepts bare strings, so a model that ignores the format works', () => {
		// Rejecting these would turn cosmetic disobedience into a failed plan and
		// send the pipeline off to search the raw question instead.
		expect(parseQueries('{"queries":["a","b"]}', 4)).toEqual([
			{ q: 'a', language: '' },
			{ q: 'b', language: '' }
		]);
	});

	it('falls back to the configured language for untagged queries', () => {
		expect(parseQueries('{"queries":["a",{"q":"b","language":"ja"}]}', 4, 'de')).toEqual([
			{ q: 'a', language: 'de' },
			{ q: 'b', language: 'ja' }
		]);
	});

	it('drops a bogus language rather than passing it to a provider', () => {
		expect(parseQueries('{"queries":[{"q":"a","language":"de&safe=off"}]}', 4)).toEqual([
			{ q: 'a', language: '' }
		]);
	});

	it('honours the cap and skips empty entries', () => {
		expect(parseQueries('{"queries":["a","","  ",{"q":""},"b","c"]}', 2)).toEqual([
			{ q: 'a', language: '' },
			{ q: 'b', language: '' }
		]);
	});

	it('returns nothing for output with no JSON object in it', () => {
		expect(parseQueries('sure! here you go', 4)).toEqual([]);
	});
});

describe('resolveEffort', () => {
	it('accepts the three levels, in any casing', () => {
		expect(resolveEffort('quick')).toBe('quick');
		expect(resolveEffort('  EXHAUSTIVE ')).toBe('exhaustive');
	});

	it('falls back to balanced rather than rejecting a bad value', () => {
		// The run behind a typo'd effort is still a valid question; refusing it
		// would turn a client bug into a failed research request.
		for (const bad of [undefined, null, '', 'turbo', 7, {}]) {
			expect(resolveEffort(bad)).toBe('balanced');
		}
	});
});

describe('roundBudget', () => {
	it('scales the default ceiling into three distinct levels', () => {
		const at = (e: 'quick' | 'balanced' | 'exhaustive') => {
			const b = roundBudget(DEFAULT_RESEARCH, e);
			return [b.rounds, b.queriesPerRound, b.pagesPerRound, b.searchBudget];
		};
		expect(at('quick')).toEqual([2, 2, 2, 4]);
		expect(at('balanced')).toEqual([3, 3, 4, 9]);
		expect(at('exhaustive')).toEqual([4, 4, 6, 16]);
	});

	it('spends exactly the admin ceiling at exhaustive', () => {
		const cfg = { ...DEFAULT_RESEARCH, maxRounds: 7, maxQueries: 6, maxPages: 9 };
		const b = roundBudget(cfg, 'exhaustive');
		expect(b.rounds).toBe(researchRoundCeiling(cfg));
		expect(b.queriesPerRound).toBe(cfg.maxQueries);
		expect(b.pagesPerRound).toBe(cfg.maxPages);
		expect(b.searchBudget).toBeLessThanOrEqual(cfg.maxSearchesPerRun);
	});

	it('never inverts as effort rises, at any ceiling', () => {
		for (let maxRounds = 1; maxRounds <= RESEARCH_ROUNDS_MAX; maxRounds++) {
			const cfg = { ...DEFAULT_RESEARCH, maxRounds };
			const [q, b, e] = RESEARCH_EFFORTS.map((level) => roundBudget(cfg, level));
			for (const key of ['rounds', 'queriesPerRound', 'pagesPerRound', 'searchBudget'] as const) {
				expect(q[key], `${key} at ${maxRounds}`).toBeLessThanOrEqual(b[key]);
				expect(b[key], `${key} at ${maxRounds}`).toBeLessThanOrEqual(e[key]);
			}
		}
	});

	it('collapses rather than reaching zero when the ceiling is minimal', () => {
		// A one-round install should make every level behave the same, not make
		// the cheapest one buy nothing at all.
		const cfg = {
			...DEFAULT_RESEARCH,
			maxRounds: 1,
			maxQueries: 1,
			maxPages: 1,
			maxSearchesPerRun: 1
		};
		for (const level of RESEARCH_EFFORTS) {
			const b = roundBudget(cfg, level);
			expect(b).toMatchObject({ rounds: 1, queriesPerRound: 1, pagesPerRound: 1, searchBudget: 1 });
		}
	});

	it('clamps a ceiling stored past the allowed maximum', () => {
		expect(roundBudget({ ...DEFAULT_RESEARCH, maxRounds: 999 }, 'exhaustive').rounds).toBe(
			RESEARCH_ROUNDS_MAX
		);
	});
});

describe('researchRoundCeiling', () => {
	it('reads maxRounds when it is set', () => {
		expect(researchRoundCeiling({ maxRounds: 5 })).toBe(5);
	});

	it('translates a legacy iterationCap, which counted extra rounds', () => {
		expect(researchRoundCeiling({ iterationCap: 1 })).toBe(2);
		expect(researchRoundCeiling({ iterationCap: 0 })).toBe(1);
	});

	it('prefers maxRounds when a stale iterationCap is still on the row', () => {
		expect(researchRoundCeiling({ maxRounds: 6, iterationCap: 1 })).toBe(6);
	});

	it('falls back to the default for absent or nonsense values', () => {
		expect(researchRoundCeiling({})).toBe(DEFAULT_RESEARCH.maxRounds);
		expect(researchRoundCeiling({ iterationCap: -3 })).toBe(DEFAULT_RESEARCH.maxRounds);
		expect(researchRoundCeiling({ maxRounds: 99 })).toBe(RESEARCH_ROUNDS_MAX);
	});
});

describe('normaliseResearchSettings', () => {
	it('folds the legacy key away instead of leaving both on the row', () => {
		const out = normaliseResearchSettings({ iterationCap: 2, maxQueries: 3 });
		expect(out.maxRounds).toBe(3);
		expect(out).not.toHaveProperty('iterationCap');
	});

	it('clamps values a raw API call could otherwise store', () => {
		// The admin form's min/max attributes do not survive a direct PUT.
		const out = normaliseResearchSettings({
			maxQueries: 500,
			maxPages: 0,
			maxSearchesPerRun: -1,
			timeoutMs: 10,
			provider: 'not-a-provider'
		});
		expect(out).toMatchObject({
			maxQueries: 10,
			maxPages: 1,
			maxSearchesPerRun: 1,
			timeoutMs: 2000,
			provider: 'inherit'
		});
	});

	it('accepts numbers that arrived as strings from the form', () => {
		expect(normaliseResearchSettings({ maxPages: '6' }).maxPages).toBe(6);
	});
});

describe('parseBrief', () => {
	const opts = { knownSources: [1, 4, 7], maxQueries: 3 };

	it('parses findings, gaps, conflicts and follow-up queries', () => {
		const out = parseBrief(
			`{"findings":[{"claim":"A holds","sources":[1,4]}],"gaps":["what about B"],
			  "conflicts":["1 vs 4"],"sufficient":false,
			  "next_queries":[{"q":"B details","language":"de"}]}`,
			opts
		);
		expect(out?.brief).toEqual({
			findings: [{ claim: 'A holds', sources: [1, 4], support: 'read' }],
			gaps: ['what about B'],
			conflicts: ['1 vs 4'],
			sufficient: false
		});
		expect(out?.queries).toEqual([{ q: 'B details', language: 'de' }]);
	});

	it('still accepts a bare-string finding, so a model that ignores the shape works', () => {
		// Same tolerance parseQueries shows, and for the same reason: cosmetic
		// disobedience should not cost the whole round.
		// An uncited claim gets the weaker grade — nothing was read to back it.
		expect(parseBrief('{"findings":["A holds"],"gaps":[]}', opts)?.brief.findings).toEqual([
			{ claim: 'A holds', sources: [], support: 'snippet' }
		]);
	});

	it('drops citations to sources that do not exist, and collapses repeats', () => {
		// A number that survived here would reach synthesis and read as sourced.
		const out = parseBrief('{"findings":[{"claim":"x","sources":[1,9,1,"4"]}],"gaps":[]}', opts);
		expect(out?.brief.findings[0].sources).toEqual([1, 4]);
	});

	it('caps the brief so carried context cannot grow round on round', () => {
		const findings = Array.from({ length: 30 }, (_, i) => ({ claim: `claim ${i}`, sources: [] }));
		const gaps = Array.from({ length: 30 }, (_, i) => `gap ${i}`);
		const out = parseBrief(JSON.stringify({ findings, gaps }), opts);
		expect(out?.brief.findings).toHaveLength(16);
		expect(out?.brief.gaps).toHaveLength(6);
	});

	it('grades a finding by whether anything backing it was read', () => {
		// This is the Meeple Mountain failure: a claim resting only on a search
		// snippet used to be indistinguishable from a read-page claim one round
		// later, and could harden into an established finding.
		const graded = parseBrief(
			'{"findings":[{"claim":"read one","sources":[1]},{"claim":"thin one","sources":[4]}],"gaps":[]}',
			{ ...opts, knownSources: [1, 4], readSources: [1] }
		);
		expect(graded?.brief.findings.map((f) => f.support)).toEqual(['read', 'snippet']);
	});

	it('clips an over-long claim rather than carrying it whole', () => {
		const out = parseBrief(JSON.stringify({ findings: ['x'.repeat(900)], gaps: [] }), opts);
		expect(out?.brief.findings[0].claim).toHaveLength(400);
	});

	it('honours the query cap and drops a bogus language', () => {
		const out = parseBrief(
			'{"gaps":["g"],"next_queries":[{"q":"a","language":"de&safe=off"},"b","c","d"]}',
			opts
		);
		expect(out?.queries).toEqual([
			{ q: 'a', language: '' },
			{ q: 'b', language: '' },
			{ q: 'c', language: '' }
		]);
	});

	it('returns null for prose or malformed JSON instead of throwing', () => {
		expect(parseBrief('sure, here is what I found', opts)).toBeNull();
		expect(parseBrief('{"findings":[oops}', opts)).toBeNull();
	});

	it('returns null for a brief with nothing in it', () => {
		// Nothing established, nothing missing, not called done — that is a model
		// answering a different question, and the caller must say so.
		expect(parseBrief('{"findings":[],"gaps":[],"sufficient":false}', opts)).toBeNull();
	});

	it('accepts a bare sufficiency verdict', () => {
		expect(parseBrief('{"sufficient":true}', opts)?.brief.sufficient).toBe(true);
	});
});

describe('mergeBrief', () => {
	const prior = briefOf({
		findings: [{ claim: 'A holds', sources: [1], support: 'read' }],
		gaps: ['what about B'],
		conflicts: ['1 vs 4']
	});
	const next = (over: Partial<Omit<ResearchBrief, 'round'>> = {}) => ({
		findings: [],
		gaps: [],
		conflicts: [],
		sufficient: false,
		...over
	});

	it('carries prior findings forward when the round restates none', () => {
		expect(mergeBrief(prior, next({ gaps: ['still B'] }), 2).findings).toEqual(prior.findings);
	});

	it('takes the round\'s own wording for a restated finding', () => {
		const merged = mergeBrief(
			prior,
			next({ findings: [{ claim: 'a holds', sources: [4], support: 'read' }] }),
			2
		);
		expect(merged.findings).toEqual([{ claim: 'a holds', sources: [4], support: 'read' }]);
	});

	it('lets a correction replace the stale claim outright', () => {
		// Under the old merge the two coexisted: a correction is a reword, and
		// reworded findings were distinct keys, so both reached the answer.
		const merged = mergeBrief(
			prior,
			next({ findings: [{ claim: 'A does not hold', sources: [7], support: 'read' }] }),
			2
		);
		expect(merged.findings.map((f) => f.claim)).toEqual(['A does not hold']);
	});

	it('treats an omitted finding as withdrawn', () => {
		// The round is shown the whole prior brief and the source register, so
		// leaving something out is a decision it made, not one it forgot.
		const merged = mergeBrief(
			prior,
			next({ findings: [{ claim: 'Something else entirely', sources: [2], support: 'read' }] }),
			2
		);
		expect(merged.findings.map((f) => f.claim)).toEqual(['Something else entirely']);
	});

	it('accumulates conflicts, which stay true whether or not a round repeats them', () => {
		const merged = mergeBrief(prior, next({ findings: [], conflicts: ['2 vs 7'] }), 2);
		expect(merged.conflicts).toEqual(['2 vs 7', '1 vs 4']);
	});

	it('keeps prior gaps when an unfinished round returns none', () => {
		// An empty gap list from a model that also said "not sufficient" is a
		// formatting slip; dropping them would end the run a round early.
		expect(mergeBrief(prior, next(), 2).gaps).toEqual(prior.gaps);
	});

	it('clears the gaps once the evidence is called sufficient', () => {
		expect(mergeBrief(prior, next({ sufficient: true }), 2).gaps).toEqual([]);
	});

	it('records the round it was merged in', () => {
		expect(mergeBrief(prior, next({ gaps: ['g'] }), 5).round).toBe(5);
	});
});

describe('gapQueries and dedupeQueries', () => {
	it('turns the brief’s own gaps into searches', () => {
		const brief = briefOf({ gaps: ['what about B', 'and C', 'and D'] });
		expect(gapQueries(brief, 2, 'de')).toEqual([
			{ q: 'what about B', language: 'de' },
			{ q: 'and C', language: 'de' }
		]);
	});

	it('yields nothing when there are no gaps', () => {
		expect(gapQueries(EMPTY_BRIEF, 3)).toEqual([]);
	});

	it('drops follow-ups that repeat a search already made', () => {
		const next = [
			{ q: 'Bundestag  Sitzung', language: 'de' },
			{ q: 'something new', language: '' },
			{ q: 'SOMETHING NEW', language: '' }
		];
		expect(dedupeQueries(next, ['bundestag sitzung'])).toEqual([
			{ q: 'something new', language: '' }
		]);
	});
});

describe('evidenceExcerptBudget and clipExcerpt', () => {
	it('shares the total out and stays inside it', () => {
		expect(evidenceExcerptBudget(6, 12_000, 600, 2_400)).toBe(2_000);
		expect(evidenceExcerptBudget(10, 12_000, 600, 2_400)).toBe(1_200);
	});

	it('respects the floor and the ceiling', () => {
		expect(evidenceExcerptBudget(2, 12_000, 600, 2_400)).toBe(2_400);
		expect(evidenceExcerptBudget(100, 12_000, 600, 2_400)).toBe(600);
		expect(evidenceExcerptBudget(0, 12_000, 600, 2_400)).toBe(2_400);
	});

	it('leaves an excerpt alone under the limit and marks one over it', () => {
		expect(clipExcerpt('short', 100)).toBe('short');
		const clipped = clipExcerpt('x'.repeat(500), 100);
		expect(clipped).toContain('…[clipped]');
		expect(clipped.startsWith('x'.repeat(100))).toBe(true);
	});
});

describe('shouldStopAfterRound', () => {
	const healthy = {
		round: 1,
		rounds: 4,
		freshCount: 3,
		evidenceCount: 3,
		searchesLeft: 5,
		aborted: false
	};

	it('carries on mid-run with sources, room and searches left', () => {
		expect(shouldStopAfterRound(healthy)).toBeNull();
	});

	it('lets a stop win over everything else', () => {
		expect(shouldStopAfterRound({ ...healthy, aborted: true })).toBe('cancelled');
	});

	it('stops immediately when nothing at all was retrieved', () => {
		expect(shouldStopAfterRound({ ...healthy, evidenceCount: 0, freshCount: 0 })).toBe('no-sources');
	});

	it('stops on the last allowed round', () => {
		expect(shouldStopAfterRound({ ...healthy, round: 4 })).toBe('rounds');
	});

	it('stops when a round turned up only addresses already read', () => {
		expect(shouldStopAfterRound({ ...healthy, freshCount: 0 })).toBe('no-new-sources');
	});

	it('stops when the run has no searches left to spend', () => {
		expect(shouldStopAfterRound({ ...healthy, searchesLeft: 0 })).toBe('search-budget');
	});
});

describe('consolidate', () => {
	const base = {
		systemPrompt: 'you are the research agent',
		asked: 'what changed?',
		question: 'what changed?',
		prior: EMPTY_BRIEF,
		fresh: [source(7)],
		allEvidence: [source(7)],
		ranQueries: ['first search'],
		round: 1,
		rounds: 3,
		maxQueries: 3,
		cfg: DEFAULT_RESEARCH,
		track: () => {}
	};
	const valid = '{"findings":[{"claim":"A holds","sources":[7]}],"gaps":["B?"],"next_queries":["B"]}';

	it('returns a brief and the follow-ups it derived', async () => {
		const out = await consolidate({ ...base, choice: choiceOf(ok(valid)) });
		expect(out.status).toBe('ok');
		if (out.status !== 'ok') return;
		expect(out.brief.findings).toEqual([{ claim: 'A holds', sources: [7], support: 'read' }]);
		expect(out.queries).toEqual([{ q: 'B', language: '' }]);
	});

	it('retries with more room when the model spent its budget reasoning', async () => {
		const usage = { promptTokens: 5, completionTokens: 7 };
		let total = 0;
		const out = await consolidate({
			...base,
			choice: choiceOf({ ...reasonedOut, usage }, { ...ok(valid), usage }),
			track: (u) => {
				total += u?.completionTokens ?? 0;
			}
		});
		expect(out.status).toBe('ok');
		expect(total).toBe(14);
	});

	it('reports an empty answer rather than ending the run in silence', async () => {
		const out = await consolidate({ ...base, choice: choiceOf(reasonedOut) });
		expect(out).toEqual({ status: 'empty', reasonedOnly: true });
	});

	it('reports unparseable output separately from an empty one', async () => {
		const out = await consolidate({ ...base, choice: choiceOf(ok('sure, here you go')) });
		expect(out.status).toBe('unparseable');
	});

	it('reports a failed call instead of throwing', async () => {
		const choice = choiceOf();
		choice.adapter.complete = (async () => {
			throw new Error('provider down');
		}) as typeof choice.adapter.complete;
		const out = await consolidate({ ...base, choice });
		expect(out.status).toBe('error');
		if (out.status === 'error') expect(out.error).toContain('provider down');
	});

	it('reports a stop as cancelled, not as a failure', async () => {
		const choice = choiceOf();
		choice.adapter.complete = (async () => {
			throw new Error('aborted');
		}) as typeof choice.adapter.complete;
		const out = await consolidate({ ...base, choice, signal: AbortSignal.abort() });
		expect(out).toEqual({ status: 'cancelled' });
	});

	it('accepts a sufficiency verdict with no follow-ups', async () => {
		const out = await consolidate({ ...base, choice: choiceOf(ok('{"sufficient":true}')) });
		expect(out.status).toBe('ok');
		if (out.status !== 'ok') return;
		expect(out.brief.sufficient).toBe(true);
		expect(out.queries).toEqual([]);
	});

	it('shows the model the excerpts, the prior brief and what was already searched', async () => {
		// The regression guard for the defect this replaced: the old review step
		// saw source titles only, so it could not narrow on what had been read.
		const choice = choiceOf(ok(valid));
		const prompt = spyOn(choice);
		await consolidate({
			...base,
			choice,
			prior: briefOf({ findings: [{ claim: 'established earlier', sources: [1], support: 'read' }] }),
			fresh: [source(7, 'the page said something specific')]
		});
		expect(prompt()).toContain('the page said something specific');
		expect(prompt()).toContain('established earlier');
		expect(prompt()).toContain('[7]');
		expect(prompt()).toContain('"first search"');
		expect(prompt()).toMatch(/local language/i);
		expect(prompt()).toContain('"next_queries"');
	});

	it('clips a long excerpt so the prompt stays bounded', async () => {
		const choice = choiceOf(ok(valid));
		const prompt = spyOn(choice);
		await consolidate({ ...base, choice, fresh: [source(7, 'y'.repeat(5000))] });
		expect(prompt()).toContain('…[clipped]');
		expect(prompt().length).toBeLessThan(5000);
	});

	it('carries the system prompt, which the review step it replaces never did', async () => {
		const choice = choiceOf(ok(valid));
		let role = '';
		const inner = choice.adapter.complete;
		choice.adapter.complete = ((req: { messages: { role: string }[] }, signal: AbortSignal) => {
			role = req.messages[0].role;
			return inner(req as never, signal);
		}) as typeof inner;
		await consolidate({ ...base, choice });
		expect(role).toBe('system');
	});
});

describe('briefToPrompt', () => {
	it('says so plainly before anything has been consolidated', () => {
		expect(briefToPrompt(EMPTY_BRIEF)).toMatch(/nothing established yet/);
	});

	it('lists findings with their sources, then gaps and conflicts', () => {
		const text = briefToPrompt(
			briefOf({
				findings: [{ claim: 'A holds', sources: [1, 4], support: 'read' }],
				gaps: ['what about B'],
				conflicts: ['1 vs 4']
			})
		);
		expect(text).toContain('- A holds [1,4]');
		expect(text).toContain('Open gaps:');
		expect(text).toContain('- what about B');
		expect(text).toContain('Conflicts:');
	});
});

describe('extractReadableHtml', () => {
	const page = (body: string) => `<html><head><title>T</title></head><body>${body}</body></html>`;
	const article = `<article><header><h1>The headline</h1><p>By a reporter</p></header><p>${'Real prose. '.repeat(30)}</p></article>`;

	it('keeps the content subtree and drops the chrome around it', () => {
		const out = extractReadableHtml(
			page(`<nav>Home Contact Login</nav><main>${article}</main><footer>Cookie notice</footer>`)
		);
		expect(out).toContain('Real prose.');
		expect(out).not.toContain('Home Contact Login');
		expect(out).not.toContain('Cookie notice');
	});

	it('keeps a header inside the article, which carries the headline', () => {
		const out = extractReadableHtml(page(`<main>${article}</main>`));
		expect(out).toContain('The headline');
		expect(out).toContain('By a reporter');
	});

	it('drops the page header when the page named no content subtree', () => {
		const out = extractReadableHtml(
			page(`<header>Site chrome</header><p>${'Body text. '.repeat(40)}</p>`)
		);
		expect(out).not.toContain('Site chrome');
		expect(out).toContain('Body text.');
	});

	it('joins every article when there is no main', () => {
		const out = extractReadableHtml(
			page(
				`<article><p>${'First piece. '.repeat(20)}</p></article><article><p>Second piece.</p></article>`
			)
		);
		expect(out).toContain('First piece.');
		expect(out).toContain('Second piece.');
	});

	it('ignores a closing tag written inside a script', () => {
		// Scripts go first for exactly this reason: otherwise a site's own JS can
		// steer which subtree is treated as the content.
		const out = extractReadableHtml(
			page(`<script>var s = "</main>";</script><main>${article}</main>`)
		);
		expect(out).toContain('Real prose.');
		expect(out).not.toContain('var s');
	});

	it('does not let an unclosed nav swallow the article', () => {
		const huge = 'x'.repeat(30_000);
		const out = extractReadableHtml(page(`<nav>${huge}<p>${'Kept prose. '.repeat(40)}</p>`));
		expect(out).toContain('Kept prose.');
	});

	it('leaks the outer wrapper rather than deleting content when navs nest', () => {
		const out = extractReadableHtml(
			page(`<nav>outer<nav>inner</nav>${'Survives. '.repeat(40)}</nav>`)
		);
		expect(out).toContain('Survives.');
	});

	it('falls back to the document when main is an empty shell', () => {
		const out = extractReadableHtml(
			page(`<main><div id="root"></div></main><p>${'Rendered elsewhere. '.repeat(30)}</p>`)
		);
		expect(out).toContain('Rendered elsewhere.');
	});
});

describe('htmlToReadableText', () => {
	it('puts the article, not the navigation, in the first page of text', () => {
		// The defect this exists for: the clip is from the top, so 8 KB of chrome
		// ahead of the article used to consume the whole excerpt.
		const nav = `<nav>${'Some menu link. '.repeat(500)}</nav>`;
		const html = `<html><body>${nav}<main><p>${'The actual finding. '.repeat(60)}</p></main></body></html>`;
		const text = clipPage(htmlToReadableText(html));
		expect(text).toContain('The actual finding.');
		expect(text).not.toContain('Some menu link.');
	});

	it('returns the plain conversion when stripping left almost nothing', () => {
		// Everything is inside elements the stripper removes, so the net catches it.
		const html = `<html><body><form>${'Only inside a form. '.repeat(60)}</form></body></html>`;
		expect(htmlToReadableText(html)).toContain('Only inside a form.');
	});

	it('leaves a short page alone', () => {
		expect(htmlToReadableText('<html><body><p>Tiny.</p></body></html>')).toBe('Tiny.');
	});
});

describe('htmlToText entities', () => {
	it('decodes numeric entities, which used to survive as literal garbage', () => {
		expect(htmlToText('<p>it&#8217;s &#x2014; here</p>')).toBe('it’s — here');
	});

	it('does not double-decode an escaped entity', () => {
		// &amp;lt; means the page wanted to show "&lt;", not "<".
		expect(htmlToText('<p>&amp;lt;</p>')).toBe('&lt;');
	});
});

describe('clipPage', () => {
	it('leaves text under the budget alone', () => {
		expect(clipPage('short')).toBe('short');
	});

	it('clips at a paragraph boundary near the budget when there is one', () => {
		const text = `${'a'.repeat(PAGE_TEXT_CHARS - 200)}\n\n${'b'.repeat(500)}`;
		expect(clipPage(text)).toBe('a'.repeat(PAGE_TEXT_CHARS - 200));
	});

	it('takes the hard budget when no boundary is near enough', () => {
		expect(clipPage('c'.repeat(PAGE_TEXT_CHARS * 2))).toHaveLength(PAGE_TEXT_CHARS);
	});
});

describe('canonicalUrlKey', () => {
	it('collapses scheme, www, a trailing slash and a fragment onto one key', () => {
		const keys = [
			'https://example.com/a/b',
			'http://example.com/a/b',
			'https://www.example.com/a/b/',
			'https://EXAMPLE.com/a/b#section'
		].map(canonicalUrlKey);
		expect(new Set(keys).size).toBe(1);
	});

	it('strips tracking parameters', () => {
		expect(canonicalUrlKey('https://example.com/a?utm_source=x&fbclid=y&gclid=z')).toBe(
			'example.com/a'
		);
	});

	it('keeps parameters that select content', () => {
		// Dropping these would merge two different pages and lose one - the worse
		// error of the two.
		expect(canonicalUrlKey('https://youtube.com/watch?v=abc')).toContain('v=abc');
		expect(canonicalUrlKey('https://example.com/p?id=7')).toContain('id=7');
		expect(canonicalUrlKey('https://example.com/p?ref=nav')).toContain('ref=nav');
	});

	it('sorts surviving parameters so order cannot make a second key', () => {
		expect(canonicalUrlKey('https://example.com/a?b=1&a=2')).toBe(
			canonicalUrlKey('https://example.com/a?a=2&b=1')
		);
	});

	it('lowercases the host but not the path', () => {
		expect(canonicalUrlKey('https://Example.com/CaseSensitive')).toBe('example.com/CaseSensitive');
	});

	it('returns nothing for anything that is not a fetchable page', () => {
		for (const bad of ['mailto:a@b.com', 'javascript:alert(1)', 'not a url', '']) {
			expect(canonicalUrlKey(bad), bad).toBe('');
		}
	});
});

describe('registrableDomain', () => {
	it('folds subdomains onto one bucket', () => {
		expect(registrableDomain('a.foo.com')).toBe('foo.com');
		expect(registrableDomain('b.deep.foo.com')).toBe('foo.com');
	});

	it('handles compound suffixes', () => {
		expect(registrableDomain('news.bbc.co.uk')).toBe('bbc.co.uk');
		expect(registrableDomain('shop.example.com.au')).toBe('example.com.au');
	});
});

describe('triageResults', () => {
	const hit = (url: string, title = url): SearchResult => ({ url, title, snippet: 's' });

	it('drops near-duplicates that differ only by tracking parameters', () => {
		const out = triageResults(
			[hit('https://a.com/x'), hit('https://a.com/x?utm_source=news'), hit('https://b.com/y')],
			{ limit: 5 }
		);
		expect(out.picked.map((r) => r.url)).toEqual(['https://a.com/x', 'https://b.com/y']);
		expect(out.dropped.duplicate).toBe(1);
	});

	it('drops what has already been read, matching on the canonical key', () => {
		const out = triageResults([hit('https://a.com/x?utm_source=q'), hit('https://b.com/y')], {
			limit: 5,
			known: ['https://www.a.com/x/']
		});
		expect(out.picked.map((r) => r.url)).toEqual(['https://b.com/y']);
		expect(out.dropped.known).toBe(1);
	});

	it('stops one site from taking a whole round', () => {
		const results = [
			...Array.from({ length: 6 }, (_, i) => hit(`https://farm.com/${i}`)),
			hit('https://other.com/a'),
			hit('https://third.com/b')
		];
		const out = triageResults(results, { limit: 6, perDomain: 2 });
		expect(out.picked.filter((r) => r.url.includes('farm.com'))).toHaveLength(2);
		expect(out.dropped.domainCap).toBe(4);
	});

	it('interleaves domains while keeping rank within each', () => {
		const out = triageResults(
			[
				hit('https://a.com/1'),
				hit('https://a.com/2'),
				hit('https://b.com/1'),
				hit('https://b.com/2')
			],
			{ limit: 4, perDomain: 2 }
		);
		expect(out.picked.map((r) => r.url)).toEqual([
			'https://a.com/1',
			'https://b.com/1',
			'https://a.com/2',
			'https://b.com/2'
		]);
	});

	it('demotes index pages without dropping them', () => {
		const out = triageResults([hit('https://a.com/tag/games'), hit('https://b.com/article')], {
			limit: 2
		});
		expect(out.picked.map((r) => r.url)).toEqual([
			'https://b.com/article',
			'https://a.com/tag/games'
		]);
	});

	it('drops results that could never be fetched', () => {
		const out = triageResults([hit('javascript:alert(1)'), hit('https://a.com/x')], { limit: 3 });
		expect(out.picked.map((r) => r.url)).toEqual(['https://a.com/x']);
		expect(out.dropped.unusable).toBe(1);
	});

	it('offers a pool at least as large as the picks, in the same order', () => {
		const results = Array.from({ length: 12 }, (_, i) => hit(`https://s${i}.com/x`));
		const out = triageResults(results, { limit: 3 });
		expect(out.pool.length).toBeGreaterThanOrEqual(out.picked.length);
		expect(out.pool.slice(0, 3)).toEqual(out.picked);
	});

	it('is deterministic', () => {
		const results = Array.from({ length: 9 }, (_, i) => hit(`https://s${i % 3}.com/${i}`));
		expect(triageResults(results, { limit: 4 })).toEqual(triageResults(results, { limit: 4 }));
	});
});

describe('parseTriagePicks', () => {
	it('takes the ids it was given, in order', () => {
		expect(parseTriagePicks('{"open":[3,1,7]}', 8, 5)).toEqual([3, 1, 7]);
	});

	it('ignores ids outside the pool, repeats and non-integers', () => {
		expect(parseTriagePicks('{"open":[0,3,3,99,"2",1.5,2]}', 5, 5)).toEqual([3, 2]);
	});

	it('honours the cap', () => {
		expect(parseTriagePicks('{"open":[1,2,3,4]}', 8, 2)).toEqual([1, 2]);
	});

	it('returns nothing for prose, so the round keeps the heuristic order', () => {
		expect(parseTriagePicks('I would read the second one', 5, 3)).toEqual([]);
		expect(parseTriagePicks('{"open":[oops}', 5, 3)).toEqual([]);
	});
});

describe('triagePages', () => {
	const pool: SearchResult[] = Array.from({ length: 6 }, (_, i) => ({
		url: `https://s${i}.com/x`,
		title: `Result ${i}`,
		snippet: `snippet ${i}`
	}));
	const base = {
		systemPrompt: 'sys',
		question: 'what changed?',
		gaps: ['what proportion is helium'],
		pool,
		limit: 2,
		track: () => {}
	};

	it('opens the pages the model chose', async () => {
		const out = await triagePages({ ...base, choice: choiceOf(ok('{"open":[3,1]}')) });
		expect(out.map((r) => r.url)).toEqual(['https://s2.com/x', 'https://s0.com/x']);
	});

	it('shows the model the open gaps and the candidates', async () => {
		const choice = choiceOf(ok('{"open":[1]}'));
		const prompt = spyOn(choice);
		await triagePages({ ...base, choice });
		expect(prompt()).toContain('what proportion is helium');
		expect(prompt()).toContain('Result 3');
		expect(prompt()).toContain('"open"');
	});

	it('has no opinion when the model returns prose', async () => {
		expect(await triagePages({ ...base, choice: choiceOf(ok('read the first one')) })).toEqual([]);
	});

	it('has no opinion when the call throws, so the round is never lost', async () => {
		const choice = choiceOf();
		choice.adapter.complete = (async () => {
			throw new Error('provider down');
		}) as typeof choice.adapter.complete;
		expect(await triagePages({ ...base, choice })).toEqual([]);
	});

	it('does not ask when there is no real choice to make', async () => {
		let called = false;
		const choice = choiceOf(ok('{"open":[1]}'));
		const inner = choice.adapter.complete;
		choice.adapter.complete = ((req: never, signal: AbortSignal) => {
			called = true;
			return inner(req, signal);
		}) as typeof inner;
		expect(await triagePages({ ...base, choice, limit: 6 })).toEqual([]);
		expect(called).toBe(false);
	});
});

describe('readPages', () => {
	const hit = (url: string, snippet = 'the search summary'): SearchResult => ({
		url,
		title: `Title for ${url}`,
		snippet
	});
	const noop = () => {};

	it('reads the triaged picks rather than raw search order', async () => {
		const out = await readPages(
			[hit('https://a.com/1'), hit('https://a.com/2'), hit('https://b.com/1')],
			[],
			2,
			100,
			noop,
			{ readPage: async (url) => `body of ${url}` }
		);
		// Domain round-robin, not simply the first two results.
		expect(out.map((e) => e.url)).toEqual(['https://a.com/1', 'https://b.com/1']);
	});

	it('marks a source as snippet-only when the fetch fails', async () => {
		const out = await readPages([hit('https://a.com/1')], [], 2, 100, noop, {
			readPage: async () => {
				throw new Error('HTTP 403');
			}
		});
		expect(out[0]).toMatchObject({ kind: 'snippet', excerpt: 'the search summary' });
	});

	it('marks a source as snippet-only when the page has no readable text', async () => {
		// A 200 that extracts to nothing is a JS shell or a paywall, not a page.
		const out = await readPages([hit('https://a.com/1')], [], 2, 100, noop, {
			readPage: async () => '   '
		});
		expect(out[0].kind).toBe('snippet');
	});

	it('drops a result with neither a page nor a snippet', async () => {
		const out = await readPages([hit('https://a.com/1', '')], [], 2, 100, noop, {
			readPage: async () => {
				throw new Error('HTTP 500');
			}
		});
		expect(out).toEqual([]);
	});

	it('numbers sources after the ones already gathered', async () => {
		const out = await readPages([hit('https://b.com/1')], [source(1), source(2)], 2, 100, noop, {
			readPage: async () => 'text'
		});
		expect(out[0].n).toBe(3);
	});

	it('keeps the heuristic order when the chooser has no opinion', async () => {
		const results = Array.from({ length: 9 }, (_, i) => hit(`https://s${i}.com/x`));
		const out = await readPages(results, [], 2, 100, noop, {
			readPage: async () => 'text',
			chooser: async () => []
		});
		expect(out.map((e) => e.url)).toEqual(['https://s0.com/x', 'https://s1.com/x']);
	});

	it('never asks the chooser when the pool barely exceeds the limit', async () => {
		let asked = false;
		await readPages([hit('https://a.com/1'), hit('https://b.com/1')], [], 2, 100, noop, {
			readPage: async () => 'text',
			chooser: async () => {
				asked = true;
				return [];
			}
		});
		expect(asked).toBe(false);
	});
});

describe('fetchPageText', () => {
	const reply = (body: string, contentType?: string) =>
		new Response(body, {
			status: 200,
			headers: contentType ? { 'content-type': contentType } : {}
		});

	it('refuses an image instead of passing binary off as a source', async () => {
		await expect(
			fetchPageText('https://example.com/a.png', 1000, {
				fetchImpl: async () => reply(' ', 'image/png')
			})
		).rejects.toThrow(/Not readable as text: image\/png/);
	});

	it('reads text/plain without running it through the HTML stripper', async () => {
		const out = await fetchPageText('https://example.com/a.txt', 1000, {
			fetchImpl: async () => reply('if a < b && c > d then', 'text/plain')
		});
		expect(out).toBe('if a < b && c > d then');
	});

	it('extracts an HTML page', async () => {
		const out = await fetchPageText('https://example.com/a', 1000, {
			fetchImpl: async () =>
				reply('<html><body><nav>Menu</nav><p>Content here.</p></body></html>', 'text/html')
		});
		expect(out).toContain('Content here.');
	});

	it('sniffs a binary body even when the server claimed it was text', async () => {
		await expect(
			fetchPageText('https://example.com/a', 1000, {
				fetchImpl: async () => reply('%PDF-1.7 binary junk')
			})
		).rejects.toThrow(/binary content/);
	});

	it('still refuses a private address before any fetch happens', async () => {
		await expect(fetchPageText('http://127.0.0.1/x', 1000)).rejects.toThrow(/Blocked/);
	});
});

describe('sourcesFooter', () => {
	it('lists sources and marks the ones that were never read', () => {
		const footer = sourcesFooter([source(1), snippetSource(2)]);
		expect(footer).toContain('1. [Source 1](https://example.com/1)');
		expect(footer).toContain('2. [Source 2](https://example.com/2) — search snippet only');
	});

	it('is empty when nothing was gathered', () => {
		expect(sourcesFooter([])).toBe('');
	});
});

describe('snippet-only sources reach the model marked', () => {
	it('labels them in the consolidation prompt', async () => {
		const choice = choiceOf(ok('{"findings":[{"claim":"a","sources":[2]}],"gaps":["g"]}'));
		const prompt = spyOn(choice);
		await consolidate({
			choice,
			systemPrompt: 'sys',
			asked: 'q?',
			question: 'q?',
			prior: EMPTY_BRIEF,
			fresh: [source(1), snippetSource(2)],
			allEvidence: [source(1), snippetSource(2)],
			ranQueries: ['first'],
			round: 1,
			rounds: 3,
			maxQueries: 3,
			cfg: DEFAULT_RESEARCH,
			track: () => {}
		});
		expect(prompt()).toContain('SEARCH SNIPPET ONLY');
		expect(prompt()).toMatch(/do not rest a finding on it/i);
	});
});

describe('framingHistory', () => {
	const msg = (role: StoredMessage['role'], content: string): StoredMessage =>
		({ role, content }) as StoredMessage;

	it('drops tool exchanges and keeps the recent turns', () => {
		const all = [
			msg('user', 'old'),
			msg('tool', 'tool output'),
			msg('assistant', 'reply'),
			msg('user', 'newer')
		];
		expect(framingHistory(all).map((m) => m.content)).toEqual(['old', 'reply', 'newer']);
	});

	it('keeps only the tail of a long conversation', () => {
		const all = Array.from({ length: 30 }, (_, i) => msg('user', `m${i}`));
		const out = framingHistory(all);
		expect(out.length).toBeLessThanOrEqual(8);
		expect(out.at(-1)?.content).toBe('m29');
	});
});

describe('frameQuestion', () => {
	const history: StoredMessage[] = [
		{ role: 'user', content: 'Find me indie board game retailers' } as StoredMessage,
		{ role: 'assistant', content: 'Here are several, including Australian ones.' } as StoredMessage
	];
	const base = {
		systemPrompt: 'sys',
		message: 'do another round, focus on Arabic games',
		history,
		track: () => {}
	};

	it('resolves a follow-up into a question that stands on its own', async () => {
		const out = await frameQuestion({
			...base,
			choice: choiceOf(
				ok(
					'{"question":"Which retailers stock Arabic board games?","background":"Australian ones already found."}'
				)
			)
		});
		expect(out).toEqual({
			question: 'Which retailers stock Arabic board games?',
			background: 'Australian ones already found.',
			fellBack: null
		});
	});

	it('shows the model the conversation and the new message', async () => {
		const choice = choiceOf(ok('{"question":"q","background":""}'));
		const prompt = spyOn(choice);
		await frameQuestion({ ...base, choice });
		expect(prompt()).toContain('Find me indie board game retailers');
		expect(prompt()).toContain('do another round, focus on Arabic games');
	});

	it('carries the compaction summary when the chat has one', async () => {
		const choice = choiceOf(ok('{"question":"q","background":""}'));
		const prompt = spyOn(choice);
		await frameQuestion({ ...base, choice, compactSummary: 'Earlier: retailers in Japan.' });
		expect(prompt()).toContain('Earlier: retailers in Japan.');
	});

	it('falls back to the message as written, and says which way it failed', async () => {
		const prose = await frameQuestion({ ...base, choice: choiceOf(ok('Sure, here you go')) });
		expect(prose).toMatchObject({ question: base.message, fellBack: 'unparseable' });

		const empty = await frameQuestion({ ...base, choice: choiceOf(reasonedOut) });
		expect(empty.fellBack).toBe('empty');

		const broken = choiceOf();
		broken.adapter.complete = (async () => {
			throw new Error('down');
		}) as typeof broken.adapter.complete;
		expect((await frameQuestion({ ...base, choice: broken })).fellBack).toBe('error');
	});

	it('retries with more room when the model spent its budget reasoning', async () => {
		const out = await frameQuestion({
			...base,
			choice: choiceOf(reasonedOut, ok('{"question":"resolved","background":""}'))
		});
		expect(out.question).toBe('resolved');
		expect(out.fellBack).toBeNull();
	});
});

describe('sourceRegister', () => {
	it('lists every source compactly, with its read status', () => {
		const text = sourceRegister([source(1), snippetSource(4)]);
		expect(text).toContain('[1] Source 1 — example.com — read in full');
		expect(text).toContain('[4] Source 4 — example.com — SEARCH SNIPPET ONLY');
	});

	it('names why a source was not read when the reason is known', () => {
		const text = sourceRegister([{ ...snippetSource(2), failure: 'blocked' }]);
		expect(text).toContain('the site refused the request');
	});

	it('stays small enough to carry every round', () => {
		const many = Array.from({ length: 24 }, (_, i) => source(i + 1));
		expect(sourceRegister(many).length).toBeLessThan(2_000);
	});

	it('says so plainly when nothing has been gathered', () => {
		expect(sourceRegister([])).toBe('(no sources yet)');
	});
});

describe('the consolidation prompt carries what a round needs', () => {
	const run = async (over: Record<string, unknown> = {}) => {
		const choice = choiceOf(ok('{"findings":[{"claim":"c","sources":[1]}],"gaps":["g"]}'));
		const prompt = spyOn(choice);
		await consolidate({
			choice,
			systemPrompt: 'sys',
			asked: 'do another round on that, but focus on the helium',
			question: 'What proportion of a nebula is helium?',
			background: 'Formation was covered in an earlier turn.',
			prior: briefOf({
				findings: [{ claim: 'Meeple Mountain is an AU/NZ review site', sources: [4], support: 'snippet' }]
			}),
			// Source 4 was read in round 1 and is deliberately NOT in `fresh`.
			fresh: [source(7)],
			allEvidence: [source(1), snippetSource(4), source(7)],
			ranQueries: ['first search'],
			round: 2,
			rounds: 3,
			maxQueries: 3,
			cfg: DEFAULT_RESEARCH,
			track: () => {},
			...over
		});
		return prompt();
	};

	it('shows the original message verbatim, not only the restatement', async () => {
		// A framing that narrowed or mis-resolved the request stays visible.
		expect(await run()).toContain('do another round on that, but focus on the helium');
	});

	it('shows the framed question alongside it', async () => {
		expect(await run()).toContain('What proportion of a nebula is helium?');
	});

	it('shows what the conversation already established', async () => {
		// Without this the round can re-open a gap the conversation already closed.
		expect(await run()).toContain('Formation was covered in an earlier turn.');
	});

	it('shows a prior round source that is not in this round of evidence', async () => {
		// The regression guard for the reported failure: a carried finding cited
		// [4], and [4] appeared nowhere except a list of legal integers, so the
		// claim could only be restated, never checked.
		const prompt = await run();
		expect(prompt).toContain('[4] Source 4 — example.com — SEARCH SNIPPET ONLY');
		expect(prompt).toMatch(/use the register to check a carried finding/i);
	});

	it('marks a carried finding whose support was only a snippet', async () => {
		expect(await run()).toContain('(snippet-only support)');
	});

	it('says that leaving a finding out retracts it', async () => {
		expect(await run()).toMatch(/treated as withdrawn/i);
	});

	it('omits the restatement when framing did not change the question', async () => {
		const prompt = await run({ asked: 'same words', question: 'same words', background: '' });
		expect(prompt).not.toContain('--- RESEARCHING ---');
		expect(prompt).not.toContain('--- FROM THE CONVERSATION ---');
	});
});

describe('decodeBody', () => {
	it('reads UTF-16 rather than mistaking it for binary', () => {
		// Decoded as UTF-8 this is riddled with real NULs and the binary sniff
		// rejected the page outright — a guaranteed snippet-only source.
		const utf16 = Buffer.from('﻿<html><p>Kia ora</p></html>', 'utf16le');
		expect(decodeBody(utf16, 'text/html')).toContain('Kia ora');
	});

	it('honours the charset on the header', () => {
		const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9]); // café
		expect(decodeBody(latin1, 'text/html; charset=ISO-8859-1')).toBe('café');
	});

	it('falls back to the meta tag when the header says nothing', () => {
		const bytes = Buffer.concat([
			Buffer.from('<html><head><meta charset="iso-8859-1"></head><body>caf', 'latin1'),
			Buffer.from([0xe9]),
			Buffer.from('</body></html>', 'latin1')
		]);
		expect(decodeBody(bytes, 'text/html')).toContain('café');
	});

	it('defaults to UTF-8', () => {
		expect(decodeBody(Buffer.from('café', 'utf8'), '')).toBe('café');
	});

	it('does not throw on an encoding name it has never heard of', () => {
		expect(decodeBody(Buffer.from('hello'), 'text/html; charset=x-made-up')).toBe('hello');
	});
});

describe('safeFetch', () => {
	const ok200 = () => new Response('fine', { status: 200 });
	const redirect = (to: string) =>
		new Response('', { status: 302, headers: { location: to } });

	it('refuses a redirect into a private address', async () => {
		// The guard was pre-flight only while redirects were followed by undici,
		// so a public URL could hand us an internal one unsupervised.
		await expect(
			safeFetch('https://example.com/a', {}, async () => redirect('http://169.254.169.254/'))
		).rejects.toThrow(/Blocked/);
	});

	it('follows an ordinary redirect chain', async () => {
		let hop = 0;
		const res = await safeFetch('https://example.com/a', {}, async () =>
			hop++ === 0 ? redirect('https://example.com/b') : ok200()
		);
		expect(await res.text()).toBe('fine');
	});

	it('resolves a relative Location', async () => {
		let hop = 0;
		const seen: string[] = [];
		await safeFetch('https://example.com/one/two', {}, async (url) => {
			seen.push(String(url));
			return hop++ === 0 ? redirect('/three') : ok200();
		});
		expect(seen[1]).toBe('https://example.com/three');
	});

	it('gives up rather than looping forever', async () => {
		await expect(
			safeFetch('https://example.com/a', {}, async () => redirect('https://example.com/a'))
		).rejects.toThrow(/Too many redirects/);
	});
});

describe('classifyFetchError and isRetryableFetch', () => {
	it('separates a refusal from an outage from a timeout', () => {
		expect(classifyFetchError(new PageFetchError('blocked', 'HTTP 403', 403)).reason).toBe('blocked');
		expect(classifyFetchError(new PageFetchError('unavailable', 'HTTP 503', 503)).reason).toBe(
			'unavailable'
		);
		const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
		expect(classifyFetchError(timeout).reason).toBe('timeout');
	});

	it('unwraps the cause undici hides, instead of "fetch failed"', () => {
		const err = new TypeError('fetch failed');
		err.cause = new Error('ENOTFOUND example.invalid');
		const out = classifyFetchError(err);
		expect(out.reason).toBe('network');
		expect(out.detail).toContain('ENOTFOUND');
	});

	it('retries what is worth retrying and nothing else', () => {
		expect(isRetryableFetch(new PageFetchError('unavailable', 'HTTP 503', 503))).toBe(true);
		expect(isRetryableFetch(new PageFetchError('blocked', 'HTTP 429', 429))).toBe(true);
		expect(isRetryableFetch(new PageFetchError('blocked', 'HTTP 404', 404))).toBe(false);
		expect(isRetryableFetch(new PageFetchError('unreadable-type', 'nope'))).toBe(false);
	});
});

describe('jsonLdText', () => {
	const page = (payload: unknown) =>
		`<html><body><script type="application/ld+json">${JSON.stringify(payload)}</script><div id="app"></div></body></html>`;

	it('recovers the article body a script-only page hides', () => {
		const body = 'The full article text. '.repeat(20);
		expect(jsonLdText(page({ '@type': 'NewsArticle', articleBody: body }))).toContain(
			'The full article text.'
		);
	});

	it('digs into nested graphs', () => {
		const body = 'Nested article text. '.repeat(20);
		expect(jsonLdText(page({ '@graph': [{ '@type': 'Article', articleBody: body }] }))).toContain(
			'Nested article text.'
		);
	});

	it('ignores a malformed block rather than failing the page', () => {
		expect(jsonLdText('<script type="application/ld+json">{oops</script>')).toBe('');
	});

	it('finds nothing when there is nothing to find', () => {
		expect(jsonLdText('<html><body><p>plain</p></body></html>')).toBe('');
	});

	it('is used when the markup extraction comes back empty', () => {
		const body = 'Rescued by structured data. '.repeat(20);
		const html = `<html><body><script type="application/ld+json">${JSON.stringify({
			articleBody: body
		})}</script><div id="root"></div></body></html>`;
		expect(htmlToReadableText(html)).toContain('Rescued by structured data.');
	});
});

describe('failure reasons reach the reader and the model', () => {
	it('names the reason in the sources list', () => {
		const footer = sourcesFooter([{ ...snippetSource(1), failure: 'blocked' }]);
		expect(footer).toContain('the site refused the request');
	});

	it('names the reason in the prompt mark', async () => {
		const choice = choiceOf(ok('{"findings":[{"claim":"c","sources":[1]}],"gaps":["g"]}'));
		const prompt = spyOn(choice);
		const thin: Evidence = { ...snippetSource(1), failure: 'timeout' };
		await consolidate({
			choice,
			systemPrompt: 'sys',
			asked: 'q?',
			question: 'q?',
			prior: EMPTY_BRIEF,
			fresh: [thin],
			allEvidence: [thin],
			ranQueries: [],
			round: 1,
			rounds: 2,
			maxQueries: 2,
			cfg: DEFAULT_RESEARCH,
			track: () => {}
		});
		expect(prompt()).toContain('the request timed out');
	});

	it('counts failures per cause for the run rollup', () => {
		expect(
			countFailures([
				source(1),
				{ ...snippetSource(2), failure: 'blocked' },
				{ ...snippetSource(3), failure: 'blocked' },
				{ ...snippetSource(4), failure: 'timeout' }
			])
		).toEqual({ blocked: 2, timeout: 1 });
	});
});

describe('readPages retries', () => {
	const hit = (url: string): SearchResult => ({ url, title: 't', snippet: 'the summary' });
	const noop = () => {};

	it('gives a rate-limited page a second chance', async () => {
		let calls = 0;
		const out = await readPages([hit('https://a.com/1')], [], 2, 100, noop, {
			readPage: async () => {
				if (calls++ === 0) throw new PageFetchError('blocked', 'HTTP 429', 429);
				return 'the page after all';
			}
		});
		expect(calls).toBe(2);
		expect(out[0]).toMatchObject({ kind: 'page', excerpt: 'the page after all' });
	});

	it('does not retry a refusal that will not change', async () => {
		let calls = 0;
		await readPages([hit('https://a.com/1')], [], 2, 100, noop, {
			readPage: async () => {
				calls++;
				throw new PageFetchError('blocked', 'HTTP 403', 403);
			}
		});
		expect(calls).toBe(1);
	});

	it('records why a source fell back to its snippet', async () => {
		const out = await readPages([hit('https://a.com/1')], [], 2, 100, noop, {
			readPage: async () => {
				throw new PageFetchError('blocked', 'HTTP 403', 403);
			}
		});
		expect(out[0]).toMatchObject({ kind: 'snippet', failure: 'blocked' });
	});

	it('records a page that rendered nothing as such, not as a refusal', async () => {
		const out = await readPages([hit('https://a.com/1')], [], 2, 100, noop, {
			readPage: async () => ''
		});
		expect(out[0]).toMatchObject({ kind: 'snippet', failure: 'no-text' });
	});
});
