import { describe, it, expect } from 'vitest';
import type { ModelChoice } from '$lib/server/providers/registry';
import type { CompletionResult } from '$lib/server/providers/types';
import { DEFAULT_RESEARCH } from '$lib/server/settings';
import { assertPublicHttpUrl, htmlToText, parseQueries, planQueries } from './research';

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
		let prompt = '';
		const choice = choiceOf(ok('{"queries":["a"]}'));
		const inner = choice.adapter.complete;
		choice.adapter.complete = ((req: { messages: { content: string }[] }, signal: AbortSignal) => {
			prompt = req.messages[req.messages.length - 1].content;
			return inner(req as never, signal);
		}) as typeof inner;
		await planQueries(choice, '', 'Was ist das Bundesverfassungsgericht?', cfg, () => {});
		expect(prompt).toMatch(/local language/i);
		expect(prompt).toContain('"language"');
	});

	it('names the admin-configured extra languages in the brief', async () => {
		let prompt = '';
		const choice = choiceOf(ok('{"queries":["a"]}'));
		const inner = choice.adapter.complete;
		choice.adapter.complete = ((req: { messages: { content: string }[] }, signal: AbortSignal) => {
			prompt = req.messages[req.messages.length - 1].content;
			return inner(req as never, signal);
		}) as typeof inner;
		await planQueries(
			choice,
			'',
			'q?',
			{ ...cfg, extraLanguages: 'de, ja, not-a-language!' },
			() => {}
		);
		expect(prompt).toContain('de, ja');
		expect(prompt).not.toContain('not-a-language!');
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
