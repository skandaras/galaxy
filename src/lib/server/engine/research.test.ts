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
	assertPublicHttpUrl,
	briefToPrompt,
	clipExcerpt,
	consolidate,
	dedupeQueries,
	evidenceExcerptBudget,
	gapQueries,
	htmlToText,
	mergeBrief,
	parseBrief,
	parseQueries,
	planQueries,
	roundBudget,
	shouldStopAfterRound,
	type Evidence,
	type ResearchBrief
} from './research';

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
	excerpt
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
			findings: [{ claim: 'A holds', sources: [1, 4] }],
			gaps: ['what about B'],
			conflicts: ['1 vs 4'],
			sufficient: false
		});
		expect(out?.queries).toEqual([{ q: 'B details', language: 'de' }]);
	});

	it('still accepts a bare-string finding, so a model that ignores the shape works', () => {
		// Same tolerance parseQueries shows, and for the same reason: cosmetic
		// disobedience should not cost the whole round.
		expect(parseBrief('{"findings":["A holds"],"gaps":[]}', opts)?.brief.findings).toEqual([
			{ claim: 'A holds', sources: [] }
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
		expect(out?.brief.findings).toHaveLength(12);
		expect(out?.brief.gaps).toHaveLength(6);
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
		findings: [{ claim: 'A holds', sources: [1] }],
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

	it('does not duplicate a finding the model restated', () => {
		// Matched case-insensitively, and the round's own wording is what survives.
		const merged = mergeBrief(prior, next({ findings: [{ claim: 'a holds', sources: [4] }] }), 2);
		expect(merged.findings).toEqual([{ claim: 'a holds', sources: [4] }]);
	});

	it('puts a correction ahead of the stale claim it replaces', () => {
		const merged = mergeBrief(prior, next({ findings: [{ claim: 'A does not hold', sources: [7] }] }), 2);
		expect(merged.findings.map((f) => f.claim)).toEqual(['A does not hold', 'A holds']);
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
		question: 'what changed?',
		prior: EMPTY_BRIEF,
		fresh: [source(7)],
		knownSources: [7],
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
		expect(out.brief.findings).toEqual([{ claim: 'A holds', sources: [7] }]);
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
			prior: briefOf({ findings: [{ claim: 'established earlier', sources: [1] }] }),
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
				findings: [{ claim: 'A holds', sources: [1, 4] }],
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
