import { randomUUID } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db';
import { usageLog } from '$lib/server/db/schema';
import { appendMessage, getChat, updateChat } from '$lib/server/chats';
import type { ModelChoice } from '$lib/server/providers/registry';
import type { Usage } from '$lib/server/providers/types';
import {
	DEFAULT_RESEARCH,
	DEFAULT_WEB_SEARCH,
	getSetting,
	type ResearchSettings,
	type WebSearchSettings
} from '$lib/server/settings';
import { assertBudget } from './budget';
import { EngineError, getTaskConfig, pickModel } from './engine';
import { emitEvent } from './events';
import { completeJob, createJob, failJob, pushChunk, type LiveJob } from './jobs';
import { runWebSearch, type SearchResult } from './tools/web-search';

interface Evidence {
	n: number;
	title: string;
	url: string;
	excerpt: string;
}

/** Deep research: plan → parallel search → read pages → review → synthesis. */
export function startResearchTurn(opts: {
	chatId: string;
	userId: string;
	content: string;
}): LiveJob {
	const chat = getChat(opts.chatId, opts.userId);
	if (!chat) throw new EngineError('Chat not found');
	assertBudget(opts.userId, 'deep-research');

	const cfg = getTaskConfig('deep-research');
	const choice = pickModel(cfg?.primaryModelId ?? null);
	if (!choice) throw new EngineError('No usable model — configure one in admin');

	const searchCfg = resolveSearchCfg();
	if (searchCfg.provider === 'none') {
		throw new EngineError('Deep research needs web search configured in admin settings');
	}

	appendMessage(chat.id, { role: 'user', content: opts.content });
	if (chat.title === 'New chat') {
		updateChat(chat.id, { title: `🔭 ${opts.content.slice(0, 44)}` });
	}
	const persist = !chat.hidden;
	const job = createJob({ chatId: chat.id, userId: opts.userId, task: 'deep-research', persist });

	void runResearch(job, opts, choice, cfg?.systemPrompt ?? '', searchCfg, persist).catch((err) => {
		if (job.status === 'running') failJob(job, String(err));
	});
	return job;
}

function resolveSearchCfg(): WebSearchSettings {
	const research = getSetting<ResearchSettings>('research', DEFAULT_RESEARCH);
	const base = getSetting<WebSearchSettings>('websearch', DEFAULT_WEB_SEARCH);
	if (research.provider === 'searxng' && research.baseUrl) {
		return { ...base, provider: 'searxng', baseUrl: research.baseUrl };
	}
	if (research.provider === 'duckduckgo') {
		return { ...base, provider: 'duckduckgo' };
	}
	return base;
}

async function runResearch(
	job: LiveJob,
	opts: { chatId: string; userId: string; content: string },
	choice: ModelChoice,
	systemPrompt: string,
	searchCfg: WebSearchSettings,
	persist: boolean
): Promise<void> {
	const cfg = getSetting<ResearchSettings>('research', DEFAULT_RESEARCH);
	const totalUsage: Usage = { promptTokens: 0, completionTokens: 0 };
	const track = (u: Usage | null) => {
		if (u) {
			totalUsage.promptTokens += u.promptTokens;
			totalUsage.completionTokens += u.completionTokens;
		}
	};
	const event = (name: string, status: 'ok' | 'error', durationMs: number, detail?: Record<string, unknown>) =>
		emitEvent(
			{ userId: opts.userId, chatId: opts.chatId, task: 'deep-research', type: 'tool.call', name, status, durationMs, detail },
			{ persist }
		);

	pushChunk(job, { type: 'meta', model: choice.model.displayName });

	// 1. Plan search queries
	pushChunk(job, { type: 'stage', name: 'planning' });
	const queries = await planQueries(choice, systemPrompt, opts.content, cfg, track);
	pushChunk(job, { type: 'stage', name: 'searching', detail: `${queries.length} queries` });

	// 2 + 3. Search then read, optionally iterating once more
	let evidence: Evidence[] = [];
	let round = 0;
	let pendingQueries = queries;
	for (;;) {
		const results = await runSearches(pendingQueries, searchCfg, event);
		const fresh = await readPages(results, evidence, cfg, event);
		pushChunk(job, {
			type: 'stage',
			name: 'reading',
			detail: `${evidence.length + fresh.length} sources`
		});
		evidence = [...evidence, ...fresh];

		if (round >= cfg.iterationCap || !evidence.length) break;
		round++;
		pushChunk(job, { type: 'stage', name: 'reviewing' });
		const more = await reviewEvidence(choice, opts.content, evidence, cfg, track);
		if (!more.length) break;
		pendingQueries = more;
		pushChunk(job, { type: 'stage', name: 'searching', detail: `${more.length} follow-ups` });
	}

	// 4. Synthesis (streamed)
	pushChunk(job, { type: 'stage', name: 'synthesising' });
	const started = Date.now();
	let answer = '';
	try {
		const stream = choice.adapter.stream(
			{
				modelKey: choice.model.modelKey,
				messages: [
					{ role: 'system', content: systemPrompt },
					{
						role: 'user',
						content: [
							`RESEARCH-SYNTHESIS: Answer the question using the numbered sources. Cite as [n] inline. Be thorough but structured. If sources conflict or are thin, say so.`,
							`Question: ${opts.content}`,
							`--- SOURCES ---`,
							evidence.length
								? evidence.map((e) => `[${e.n}] ${e.title} (${e.url})\n${e.excerpt}`).join('\n\n')
								: '(no sources could be retrieved — answer from general knowledge and say that clearly)'
						].join('\n\n')
					}
				],
				maxTokens: cfg.maxTokens
			},
			AbortSignal.timeout(180_000)
		);
		for await (const ev of stream) {
			if (ev.type === 'text') {
				answer += ev.delta;
				pushChunk(job, { type: 'delta', text: ev.delta });
			} else if (ev.type === 'usage') track(ev.usage);
		}
	} catch (err) {
		emitEvent(
			{
				userId: opts.userId,
				chatId: opts.chatId,
				task: 'deep-research',
				type: 'model.call',
				name: choice.model.modelKey,
				status: 'error',
				durationMs: Date.now() - started,
				detail: { error: String(err) }
			},
			{ persist }
		);
		logUsage(opts, choice, totalUsage, 'error');
		failJob(job, `Synthesis failed: ${String(err)}`);
		return;
	}

	if (evidence.length) {
		const sources = ['', '', '**Sources**', ...evidence.map((e) => `${e.n}. [${e.title}](${e.url})`)].join('\n');
		answer += sources;
		pushChunk(job, { type: 'delta', text: sources });
	}

	const saved = appendMessage(opts.chatId, {
		role: 'assistant',
		content: answer,
		modelKey: choice.model.modelKey
	});
	logUsage(opts, choice, totalUsage, 'ok');
	emitEvent(
		{
			userId: opts.userId,
			chatId: opts.chatId,
			task: 'deep-research',
			type: 'job',
			name: 'research.turn',
			status: 'ok',
			durationMs: Date.now() - started,
			detail: { sources: evidence.length, ...totalUsage }
		},
		{ persist }
	);
	completeJob(job, saved.id);
}

async function planQueries(
	choice: ModelChoice,
	systemPrompt: string,
	question: string,
	cfg: ResearchSettings,
	track: (u: Usage | null) => void
): Promise<string[]> {
	try {
		const { text, usage } = await choice.adapter.complete(
			{
				modelKey: choice.model.modelKey,
				messages: [
					{ role: 'system', content: systemPrompt },
					{
						role: 'user',
						content: `RESEARCH-PLAN: Produce up to ${cfg.maxQueries} focused web-search queries for researching this question. Reply ONLY with JSON: {"queries":["…"]}\n\nQuestion: ${question}`
					}
				],
				maxTokens: 300
			},
			AbortSignal.timeout(60_000)
		);
		track(usage);
		const parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
		const queries = Array.isArray(parsed.queries)
			? parsed.queries.filter((q: unknown) => typeof q === 'string' && q).slice(0, cfg.maxQueries)
			: [];
		return queries.length ? queries : [question];
	} catch {
		return [question];
	}
}

async function runSearches(
	queries: string[],
	searchCfg: WebSearchSettings,
	event: (name: string, status: 'ok' | 'error', d: number, detail?: Record<string, unknown>) => void
): Promise<SearchResult[]> {
	const settled = await Promise.allSettled(
		queries.map(async (q) => {
			const started = Date.now();
			try {
				const results = await runWebSearch(q, searchCfg);
				event('web_search', 'ok', Date.now() - started, { query: q, results: results.length });
				return results;
			} catch (err) {
				event('web_search', 'error', Date.now() - started, { query: q, error: String(err) });
				return [] as SearchResult[];
			}
		})
	);
	const all = settled.flatMap((s) => (s.status === 'fulfilled' ? s.value : []));
	const seen = new Set<string>();
	return all.filter((r) => r.url && !seen.has(r.url) && seen.add(r.url));
}

async function readPages(
	results: SearchResult[],
	existing: Evidence[],
	cfg: ResearchSettings,
	event: (name: string, status: 'ok' | 'error', d: number, detail?: Record<string, unknown>) => void
): Promise<Evidence[]> {
	const known = new Set(existing.map((e) => e.url));
	const toRead = results.filter((r) => !known.has(r.url)).slice(0, cfg.maxPages);
	let n = existing.length;
	const settled = await Promise.allSettled(
		toRead.map(async (r) => {
			const started = Date.now();
			try {
				const excerpt = await fetchPageText(r.url, cfg.timeoutMs);
				event('fetch_page', 'ok', Date.now() - started, { url: r.url, chars: excerpt.length });
				return { title: r.title || r.url, url: r.url, excerpt: excerpt || r.snippet };
			} catch (err) {
				event('fetch_page', 'error', Date.now() - started, { url: r.url, error: String(err) });
				return { title: r.title || r.url, url: r.url, excerpt: r.snippet };
			}
		})
	);
	return settled
		.filter((s): s is PromiseFulfilledResult<Omit<Evidence, 'n'>> => s.status === 'fulfilled')
		.map((s) => ({ ...s.value, n: ++n }));
}

async function reviewEvidence(
	choice: ModelChoice,
	question: string,
	evidence: Evidence[],
	cfg: ResearchSettings,
	track: (u: Usage | null) => void
): Promise<string[]> {
	try {
		const { text, usage } = await choice.adapter.complete(
			{
				modelKey: choice.model.modelKey,
				messages: [
					{
						role: 'user',
						content: `RESEARCH-REVIEW: Given the question "${question}" and these source titles:\n${evidence.map((e) => `[${e.n}] ${e.title}`).join('\n')}\n\nIs the evidence sufficient? Reply ONLY JSON: {"sufficient":true} or {"sufficient":false,"more_queries":["…"]}`
					}
				],
				maxTokens: 200
			},
			AbortSignal.timeout(60_000)
		);
		track(usage);
		const parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
		if (parsed.sufficient) return [];
		return Array.isArray(parsed.more_queries)
			? parsed.more_queries.filter((q: unknown) => typeof q === 'string').slice(0, cfg.maxQueries)
			: [];
	} catch {
		return [];
	}
}

/**
 * Server-side fetch of attacker-influenced URLs (search results) must not
 * reach internal services. Blocks loopback/private/link-local hosts and IP
 * literals; ALLOW_PRIVATE_RESEARCH_FETCH=1 disables the guard for tests.
 * (DNS-rebinding is out of scope for this layer — see PLAN backlog.)
 */
export function assertPublicHttpUrl(rawUrl: string): void {
	if (env.ALLOW_PRIVATE_RESEARCH_FETCH === '1') return;
	const url = new URL(rawUrl);
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new Error(`Blocked non-http URL: ${url.protocol}`);
	}
	const h = url.hostname.toLowerCase();
	if (
		h === 'localhost' ||
		h.endsWith('.local') ||
		h.endsWith('.internal') ||
		h.endsWith('.lan') ||
		h === '::1' ||
		h.startsWith('fc') ||
		h.startsWith('fd') ||
		h.startsWith('fe80')
	) {
		throw new Error(`Blocked private host: ${h}`);
	}
	const v4 = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
	if (v4) {
		const [a, b] = [Number(v4[1]), Number(v4[2])];
		if (
			a === 0 ||
			a === 10 ||
			a === 127 ||
			(a === 192 && b === 168) ||
			(a === 172 && b >= 16 && b < 32) ||
			(a === 169 && b === 254)
		) {
			throw new Error(`Blocked private address: ${h}`);
		}
	}
}

/** Fetch a page and reduce it to readable text (no external parser deps). */
export async function fetchPageText(url: string, timeoutMs: number): Promise<string> {
	assertPublicHttpUrl(url);
	const res = await fetch(url, {
		signal: AbortSignal.timeout(timeoutMs),
		headers: { 'user-agent': 'galaxy-research/1.0', accept: 'text/html,text/plain' },
		redirect: 'follow'
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const html = await res.text();
	return htmlToText(html).slice(0, 6000);
}

export function htmlToText(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, ' ')
		.replace(/<style[\s\S]*?<\/style>/gi, ' ')
		.replace(/<!--[\s\S]*?-->/g, ' ')
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/[ \t]+/g, ' ')
		.replace(/\n\s*\n\s*/g, '\n\n')
		.trim();
}

function logUsage(
	opts: { userId: string; chatId: string },
	choice: ModelChoice,
	usage: Usage,
	status: 'ok' | 'error'
) {
	const cost =
		choice.model.promptCostPerMTok != null && choice.model.completionCostPerMTok != null
			? (usage.promptTokens * choice.model.promptCostPerMTok +
					usage.completionTokens * choice.model.completionCostPerMTok) /
				1_000_000
			: null;
	db.insert(usageLog)
		.values({
			id: randomUUID(),
			ts: new Date(),
			userId: opts.userId,
			chatId: opts.chatId,
			task: 'deep-research',
			modelKey: choice.model.modelKey,
			promptTokens: usage.promptTokens,
			completionTokens: usage.completionTokens,
			costUsd: cost,
			status
		})
		.run();
}
