import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db, runMigrations } from '$lib/server/db';
import { jobs } from '$lib/server/db/schema';
import { appendMessage, createChat, updateChat } from '$lib/server/chats';
import type { ModelChoice } from '$lib/server/providers/registry';
import type { ChatRequest, StreamEvent } from '$lib/server/providers/types';
import {
	bannedPhrases,
	countBanned,
	dumpRequest,
	parseVariant,
	runCase,
	writeRun,
	type EvalCase,
	type RunContext
} from './runner';

/**
 * The runner's mechanics, against a scripted model: each variant changes what
 * it says it changes in the request, the spend cap stops calls, fixtures stand
 * in for tools, and a run writes something an owner can score blind. Whether
 * any variant reads better is not something a test here can say.
 */

beforeAll(() => runMigrations());

const USER = 'eval-user';
const seen: ChatRequest[] = [];

/** Reports what it was sent; calls library_search once if the case asks it to. */
function scripted(opts: { price?: number } = {}): ModelChoice {
	return {
		model: {
			id: 'eval-row',
			modelKey: 'mock/eval',
			displayName: 'Eval',
			supportsTools: true,
			supportsVision: false,
			supportsReasoning: true,
			reasoningMode: 'auto',
			cacheMode: 'auto',
			promptCostPerMTok: opts.price ?? 1,
			completionCostPerMTok: opts.price ?? 1
		},
		provider: {},
		adapter: {
			async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
				seen.push(req);
				const all = req.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
				const asked = all.includes('USE-A-TOOL');
				const toolResult = req.messages.find((m) => m.role === 'tool');
				if (asked && !toolResult) {
					yield { type: 'tool_calls', calls: [{ id: 'c1', name: 'library_search', arguments: '{"query":"x"}' }] };
				} else {
					yield {
						type: 'text',
						delta: [
							`lean=${!all.includes('[Library index')}`,
							`short=${all.includes('a thoughtful colleague')}`,
							`evidence=${all.includes('BEGIN EVIDENCE')}`,
							`tool=${String(toolResult?.content ?? 'none')}`
						].join(' ')
					};
				}
				yield { type: 'usage', usage: { promptTokens: 1000, completionTokens: 100 } };
				yield { type: 'done', finishReason: 'stop' };
			},
			complete: async () => ({ text: '', usage: null }),
			listModels: async () => []
		}
	} as unknown as ModelChoice;
}

const ctx = (over: Partial<RunContext> = {}): RunContext => ({
	userId: USER,
	maxUsd: 1,
	spent: { usd: 0, unpriced: 0 },
	liveTools: false,
	models: () => ({ choice: scripted(), backup: null }),
	...over
});

const follow: EvalCase = {
	id: 'follow',
	history: [
		{ role: 'user', content: 'Read the page.' },
		{
			role: 'assistant',
			content: 'Read it.',
			evidence: [{ tool: 'fetch_url', ref: 'https://e.test', excerpt: 'PAGE-FACT' }]
		}
	],
	prompt: 'What did it say?'
};

describe('a variant', () => {
	it('changes the one thing it names', async () => {
		const base = await runCase(follow, parseVariant('baseline'), ctx());
		expect(base.reply).toBe('lean=false short=false evidence=true tool=none');
		expect((await runCase(follow, parseVariant('lean'), ctx())).reply).toContain('lean=true');
		expect((await runCase(follow, parseVariant('short-language'), ctx())).reply).toContain('short=true');
		expect((await runCase(follow, parseVariant('no-evidence'), ctx())).reply).toContain('evidence=false');
		await runCase(follow, parseVariant('effort:high'), ctx());
		expect(seen.at(-1)?.reasoning).toBe('high');
		await runCase(follow, parseVariant('pinned:acme'), ctx());
		expect(seen.at(-1)?.provider).toEqual({ order: ['acme'], allow_fallbacks: false, require_parameters: true });
	});

	it('is refused by name when it does not exist', () => {
		expect(() => parseVariant('louder')).toThrow(/Unknown variant louder/);
	});
});

describe('a run', () => {
	it('records time, calls, tokens and cost', async () => {
		const r = await runCase(follow, parseVariant('baseline'), ctx());
		expect(r).toMatchObject({ calls: 1, promptTokens: 1000, completionTokens: 100, error: null, failover: false });
		expect(r.costUsd).toBeCloseTo(0.0011);
		expect(r.ttftMs).not.toBeNull();
	});

	it('stops calling models at the spend cap', async () => {
		const r = await runCase(follow, parseVariant('baseline'), ctx({ maxUsd: 0 }));
		expect(r.calls).toBe(0);
		expect(r.error).toMatch(/Spend cap/);
	});

	it('answers tools from the case, and says so when a call was not planned for', async () => {
		const planned = await runCase(
			{ id: 'tool', prompt: 'USE-A-TOOL', toolFixtures: { library_search: 'FIXED-RESULT' } },
			parseVariant('baseline'),
			ctx()
		);
		expect(planned.reply).toContain('tool=FIXED-RESULT');
		const unplanned = await runCase({ id: 'tool2', prompt: 'USE-A-TOOL' }, parseVariant('baseline'), ctx());
		expect(unplanned.reply).toContain('No fixture for library_search');
	});

	it('writes a reply per variant, a CSV with columns to score, and a blind sheet with its key apart', async () => {
		const results = [
			await runCase(follow, parseVariant('baseline'), ctx()),
			await runCase(follow, parseVariant('lean'), ctx())
		];
		const dir = mkdtempSync(join(tmpdir(), 'eval-'));
		writeRun(dir, results, 'test-run');
		expect(existsSync(join(dir, 'follow', 'baseline.md'))).toBe(true);
		const csv = readFileSync(join(dir, 'results.csv'), 'utf8');
		expect(csv.split('\n')[0]).toContain('usefulness,judgement,style,adherence,continuity,completion');
		const blind = readFileSync(join(dir, 'blind.md'), 'utf8');
		expect(blind).not.toContain('baseline');
		// What came before, so continuity can be judged without the key.
		expect(blind).toContain('Read the page.');
		const key = JSON.parse(readFileSync(join(dir, 'blind-key.json'), 'utf8'));
		expect(Object.values(key.follow).sort()).toEqual(['baseline', 'lean']);
	});
});

describe('the request dump', () => {
	it('is the body the provider would get, with no model called', () => {
		const before = seen.length;
		const body = dumpRequest(follow, parseVariant('baseline'), ctx());
		expect(seen.length).toBe(before);
		expect(body.model).toBe('mock/eval');
		expect(JSON.stringify(body.messages)).toContain('PAGE-FACT');
		expect(body.stream).toBe(true);
		// The note the loop adds last, which a real run always carries.
		expect(JSON.stringify(body.messages)).toContain('[Turn budget');
	});
});

describe('the edges of a run', () => {
	it('calls a reply with no usage report unpriced, not free', async () => {
		const silent = scripted();
		const inner = silent.adapter.stream.bind(silent.adapter);
		silent.adapter.stream = async function* (req: ChatRequest) {
			for await (const ev of inner(req)) if (ev.type !== 'usage') yield ev;
		};
		const run = ctx({ models: () => ({ choice: silent, backup: null }) });
		const r = await runCase(follow, parseVariant('baseline'), run);
		expect(r.costUsd).toBeNull();
		expect(run.spent.unpriced).toBe(1);
	});

	it('keeps a person-facing tool on fixtures even when tools run live', async () => {
		const asking = scripted();
		asking.adapter.stream = async function* (req: ChatRequest) {
			seen.push(req);
			const asked = req.messages.find((m) => m.role === 'tool');
			if (!asked) {
				yield { type: 'tool_calls', calls: [{ id: 'q', name: 'ask_user', arguments: '{"question":"which?"}' }] };
			} else {
				yield { type: 'text', delta: `answered: ${String(asked.content)}` };
			}
			yield { type: 'done', finishReason: 'stop' };
		};
		const r = await runCase(
			{ id: 'asks', prompt: 'go' },
			parseVariant('baseline'),
			ctx({ liveTools: true, models: () => ({ choice: asking, backup: null }) })
		);
		// Answered at once from the missing fixture, where the live tool would
		// have waited for ever on a browser that is not there.
		expect(r.reply).toContain('No fixture for ask_user');
	});

	it('replays a compacted chat from its summary, as production would', async () => {
		const real = createChat({ userId: USER, title: 'Long' });
		appendMessage(real.id, { role: 'user', content: 'OLD-TURN-ONE' });
		appendMessage(real.id, { role: 'assistant', content: 'old answer' });
		appendMessage(real.id, { role: 'user', content: 'And now?' });
		updateChat(real.id, { compactSummary: 'SUMMARY-OF-EARLIER', compactedUpTo: 2 });
		await runCase({ id: 'compacted', fromChat: real.id, prompt: '' }, parseVariant('baseline'), ctx());
		const sent = JSON.stringify(seen.at(-1)?.messages);
		expect(sent).toContain('SUMMARY-OF-EARLIER');
		expect(sent).not.toContain('OLD-TURN-ONE');
	});

	it('offers a first turn the naming a real first turn gets, and a lifted hand-off its board prompt', async () => {
		await runCase({ id: 'first', prompt: 'hello' }, parseVariant('baseline'), ctx());
		expect(seen.at(-1)?.tools?.map((t) => t.name)).toContain('set_chat_title');
		const handoff = createChat({ userId: USER, agentTask: 'board' });
		appendMessage(handoff.id, { role: 'user', content: 'Card: fix the gate' });
		await runCase({ id: 'board', fromChat: handoff.id, prompt: '' }, parseVariant('baseline'), ctx());
		expect(String(seen.at(-1)?.messages[0].content)).toContain('You work on task boards in Galaxy');
	});

	it('records a case that cannot be set up as a result, so the run carries on', async () => {
		const r = await runCase({ id: 'gone', fromChat: 'no-such-chat', prompt: '' }, parseVariant('baseline'), ctx());
		expect(r.error).toMatch(/Could not set up the case/);
		expect(r.calls).toBe(0);
	});

	it('tells a replayed follow-up about the failed attempt before it, as production would', () => {
		const real = createChat({ userId: USER, title: 'Failed' });
		appendMessage(real.id, { role: 'user', content: 'Do the thing.' });
		db.insert(jobs)
			.values({ id: 'failed-job', chatId: real.id, userId: USER, task: 'chat', status: 'error', error: 'provider down', createdAt: new Date(), finishedAt: new Date() })
			.run();
		const body = dumpRequest({ id: 'retry', fromChat: real.id, prompt: 'Any luck?' }, parseVariant('baseline'), ctx());
		expect(JSON.stringify(body.messages)).toContain('provider down');
	});

	it('brings the evidence a lifted chat kept', async () => {
		const real = createChat({ userId: USER, title: 'Real' });
		appendMessage(real.id, { role: 'user', content: 'Read the page.' });
		appendMessage(real.id, {
			role: 'assistant',
			content: 'Read it.',
			evidence: [{ tool: 'fetch_url', ref: 'https://e.test', excerpt: 'LIFTED-FACT' }]
		});
		appendMessage(real.id, { role: 'user', content: 'What did it say?' });
		const r = await runCase({ id: 'lifted', fromChat: real.id, prompt: '' }, parseVariant('baseline'), ctx());
		expect(r.prompt).toBe('What did it say?');
		expect(r.reply).toContain('evidence=true');
	});
});

describe('the banned-phrase count', () => {
	it('reads the quoted phrases from the voice, skipping shapes written with placeholders', () => {
		const phrases = bannedPhrases('Avoid "Great question", "delve" and "It is not X, it is Y".');
		expect(phrases).toEqual(['Great question', 'delve']);
		expect(countBanned('Great question! Let us delve — and delve again.', phrases)).toBe(4);
	});
});
