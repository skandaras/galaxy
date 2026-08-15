import { randomUUID } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db';
import { usageLog, type AttachmentRef } from '$lib/server/db/schema';
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
import { withDocumentText } from './context';
import { EngineError, getTaskConfig, pickModel } from './engine';
import { emitEvent } from './events';
import {
	completeJob,
	createJob,
	failJob,
	isCancellation,
	pushChunk,
	type LiveJob
} from './jobs';
import { streamWithIdleTimeout } from './loop';
import { normaliseLanguage, runWebSearch, type SearchResult } from './tools/web-search';

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
	attachments?: AttachmentRef[];
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

	appendMessage(chat.id, {
		role: 'user',
		content: opts.content,
		attachments: opts.attachments
	});
	if (chat.title === 'New chat') {
		updateChat(chat.id, { title: `🔭 ${opts.content.slice(0, 44)}` });
	}
	const persist = !chat.hidden;
	const job = createJob({ chatId: chat.id, userId: opts.userId, task: 'deep-research', persist });

	// The research pipeline builds its own prompts from the question text, so
	// any attached documents have to be folded into it here.
	const question = withDocumentText(chat.id, opts.content, opts.attachments);

	void runResearch(
		job,
		{ ...opts, content: question },
		choice,
		cfg?.systemPrompt ?? '',
		searchCfg,
		persist
	).catch((err) => {
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

	// Every limit this run observes is created here, so they are unambiguously
	// per request: a second research run gets a new allowance, a new round
	// counter and a new evidence set.
	const allowance = searchAllowance(Math.max(1, cfg.maxSearchesPerRun ?? cfg.maxQueries));
	const defaultLanguage = normaliseLanguage(searchCfg.defaultLanguage);

	// 1. Plan search queries
	pushChunk(job, { type: 'stage', name: 'planning' });
	const plan = await planQueries(choice, systemPrompt, opts.content, cfg, track, defaultLanguage);
	const queries = plan.queries;
	if (plan.fellBack) {
		// Searching the raw question is a poor substitute for a real plan, and it
		// used to be indistinguishable from working normally.
		const why =
			plan.fellBack === 'empty'
				? plan.reasonedOnly
					? 'the model spent its whole token budget reasoning and returned no plan'
					: 'the model returned an empty plan'
				: plan.fellBack === 'unparseable'
					? 'the model did not return usable JSON'
					: 'the planning call failed';
		pushChunk(job, {
			type: 'notice',
			text: `Planning fell back to searching the question as written — ${why}.`
		});
		event('research.plan', 'error', 0, { fellBack: plan.fellBack, reasonedOnly: plan.reasonedOnly });
	}
	pushChunk(job, { type: 'stage', name: 'searching', detail: `${queries.length} queries` });

	// 2 + 3. Search then read, optionally iterating once more
	let evidence: Evidence[] = [];
	let round = 0;
	let pendingQueries = queries;
	for (;;) {
		// Research runs its own pipeline rather than runAgentLoop, so it checks
		// for a stop between stages — the gaps here are whole rounds of searching
		// and page fetching, which is exactly what a user wants to cut short.
		if (job.controller.signal.aborted) break;
		const results = await runSearches(pendingQueries, searchCfg, allowance, event);
		const fresh = await readPages(results, evidence, cfg, event);
		pushChunk(job, {
			type: 'stage',
			name: 'reading',
			detail: `${evidence.length + fresh.length} sources`
		});
		evidence = [...evidence, ...fresh];

		if (round >= cfg.iterationCap || !evidence.length) break;
		// No point reviewing for follow-ups there is no allowance left to run.
		if (allowance.used >= allowance.total) break;
		if (job.controller.signal.aborted) break;
		round++;
		pushChunk(job, { type: 'stage', name: 'reviewing' });
		const more = await reviewEvidence(choice, opts.content, evidence, cfg, track, defaultLanguage);
		if (!more.length) break;
		pendingQueries = more;
		pushChunk(job, { type: 'stage', name: 'searching', detail: `${more.length} follow-ups` });
	}

	// 4. Synthesis (streamed)
	if (!evidence.length) {
		// The answer that follows is general knowledge, not research. Say so
		// before it streams rather than letting it pass as a sourced result.
		pushChunk(job, {
			type: 'notice',
			text: 'No sources could be retrieved — answering from general knowledge. Check the search provider in Admin → Settings.'
		});
	}
	pushChunk(job, { type: 'stage', name: 'synthesising' });
	const started = Date.now();
	let answer = '';
	let reasoningChars = 0;
	let finishReason: string | null = null;

	const synthesise = async (maxTokens: number) => {
		// Idle-bounded, not total-bounded: synthesis over many sources is slow but
		// healthy, and a flat deadline killed it mid-answer (same defect the chat
		// and coding loops had).
		const stream = streamWithIdleTimeout(
			choice.adapter,
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
				maxTokens
			},
			job.controller.signal
		);
		for await (const ev of stream) {
			if (ev.type === 'text') {
				answer += ev.delta;
				pushChunk(job, { type: 'delta', text: ev.delta });
			} else if (ev.type === 'reasoning') {
				reasoningChars += ev.delta.length;
			} else if (ev.type === 'usage') {
				track(ev.usage);
			} else if (ev.type === 'done') {
				finishReason = ev.finishReason;
			}
		}
	};

	try {
		await synthesise(cfg.maxTokens);
		// A reasoning model can consume the entire budget thinking and stream no
		// answer at all. Nothing was shown yet, so one retry with real headroom is
		// clean — and it is the difference between a usable result and a failure.
		if (!answer.trim() && (reasoningChars > 0 || finishReason === 'length')) {
			pushChunk(job, {
				type: 'notice',
				text: 'The model used its whole token budget reasoning; retrying with more room.'
			});
			reasoningChars = 0;
			finishReason = null;
			await synthesise(Math.max(cfg.maxTokens * 4, SYNTHESIS_RETRY_TOKENS));
		}
	} catch (err) {
		// Stopping mid-synthesis is not a failure — fall through and keep
		// whatever `answer` holds, same as chat does.
		if (!isCancellation(err, job.controller.signal)) {
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
			logUsage({ ...opts, persist }, choice, totalUsage, 'error');
			failJob(job, `Synthesis failed: ${String(err)}`);
			return;
		}
	}

	// An empty synthesis must not be saved as a successful, blank reply — that
	// is precisely how a reasoning model that spent its budget thinking looked
	// like a run that "finished" with nothing to show.
	if (!answer.trim() && !job.controller.signal.aborted) {
		const why = reasoningChars
			? `The model spent its entire ${cfg.maxTokens}-token budget reasoning and produced no answer. Raise Max tokens in Admin → Research, or choose a model that is not reasoning-only.`
			: finishReason === 'length'
				? `The model hit its ${cfg.maxTokens}-token limit before writing anything. Raise Max tokens in Admin → Research.`
				: 'The model returned an empty answer.';
		emitEvent(
			{
				userId: opts.userId,
				chatId: opts.chatId,
				task: 'deep-research',
				type: 'model.call',
				name: choice.model.modelKey,
				status: 'error',
				durationMs: Date.now() - started,
				detail: { emptyAnswer: true, reasoningChars, finishReason, sources: evidence.length }
			},
			{ persist }
		);
		logUsage({ ...opts, persist }, choice, totalUsage, 'error');
		failJob(job, `Deep research produced no answer. ${why}`);
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
	logUsage({ ...opts, persist }, choice, totalUsage, 'ok');
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
	// Research runs its own pipeline rather than the agent loop, and reaching
	// here means it synthesised an answer.
	completeJob(job, saved.id, 'complete');
}

/** Planner budget. The retry is for reasoning models, which spend the first
 *  allowance thinking and return an empty answer stopped on length. */
const PLAN_TOKENS = 400;
const PLAN_TOKENS_RETRY = 4000;
/** Floor for the synthesis retry, so a small configured cap still gets room. */
const SYNTHESIS_RETRY_TOKENS = 8000;

/** One planned search: the words to send, and the index to send them to. */
export interface PlannedQuery {
	q: string;
	/** BCP-47 code, or '' for no constraint. */
	language: string;
}

export interface PlanOutcome {
	queries: PlannedQuery[];
	/** Set when the model produced no usable plan and the question is standing in. */
	fellBack: 'empty' | 'unparseable' | 'error' | null;
	reasonedOnly: boolean;
}

/**
 * Parse a plan.
 *
 * Both shapes are accepted on purpose: the tagged form is what we ask for, and
 * a bare string is what a model that ignored the format returns. Rejecting the
 * latter would turn a cosmetic disobedience into a failed plan and send the
 * pipeline off to search the raw question.
 */
export function parseQueries(text: string, max: number, fallbackLanguage = ''): PlannedQuery[] {
	const start = text.indexOf('{');
	const end = text.lastIndexOf('}');
	if (start === -1 || end <= start) return [];
	const parsed = JSON.parse(text.slice(start, end + 1));
	if (!Array.isArray(parsed.queries)) return [];
	const out: PlannedQuery[] = [];
	for (const raw of parsed.queries) {
		if (typeof raw === 'string' && raw.trim()) {
			out.push({ q: raw.trim(), language: fallbackLanguage });
		} else if (raw && typeof raw === 'object' && typeof raw.q === 'string' && raw.q.trim()) {
			out.push({
				q: raw.q.trim(),
				language: normaliseLanguage(raw.language) || fallbackLanguage
			});
		}
		if (out.length >= max) break;
	}
	return out;
}

/** The standing instruction about languages, shared by planning and review. */
function languageBrief(cfg: ResearchSettings): string {
	const extra = (cfg.extraLanguages ?? '')
		.split(',')
		.map((s) => normaliseLanguage(s))
		.filter(Boolean);
	return [
		'Search in whatever language the sources are actually written in. When the question concerns a place, institution, law, company, product or event whose primary sources are not in English, write those queries in the local language and tag them with its code — translated-into-English queries find commentary, not primary sources.',
		extra.length
			? `Always include at least one query in each of these languages as well: ${extra.join(', ')}.`
			: ''
	]
		.filter(Boolean)
		.join(' ');
}

export async function planQueries(
	choice: ModelChoice,
	systemPrompt: string,
	question: string,
	cfg: ResearchSettings,
	track: (u: Usage | null) => void,
	defaultLanguage = ''
): Promise<PlanOutcome> {
	const ask = (maxTokens: number) =>
		choice.adapter.complete(
			{
				modelKey: choice.model.modelKey,
				messages: [
					{ role: 'system', content: systemPrompt },
					{
						role: 'user',
						content: `RESEARCH-PLAN: Produce up to ${cfg.maxQueries} focused web-search queries for researching this question. ${languageBrief(cfg)} Reply ONLY with JSON: {"queries":[{"q":"…","language":"de"}]} — use "" for language when no constraint is wanted.\n\nQuestion: ${question}`
					}
				],
				maxTokens
			},
			AbortSignal.timeout(60_000)
		);

	const asked = (fellBack: PlanOutcome['fellBack'], reasonedOnly: boolean): PlanOutcome => ({
		queries: [{ q: question, language: defaultLanguage }],
		fellBack,
		reasonedOnly
	});

	try {
		let res = await ask(PLAN_TOKENS);
		track(res.usage);
		// A reasoning model can burn the whole allowance thinking and hand back
		// nothing. One retry with real headroom is the difference between a
		// planned search and silently googling the raw question.
		if (!res.text.trim() && (res.reasonedOnly || res.finishReason === 'length')) {
			res = await ask(PLAN_TOKENS_RETRY);
			track(res.usage);
		}
		const reasonedOnly = Boolean(res.reasonedOnly);
		if (!res.text.trim()) return asked('empty', reasonedOnly);
		const queries = parseQueries(res.text, cfg.maxQueries, defaultLanguage);
		return queries.length
			? { queries, fellBack: null, reasonedOnly }
			: asked('unparseable', reasonedOnly);
	} catch {
		return asked('error', false);
	}
}

/**
 * Searches remaining for one research run.
 *
 * Created inside `runResearch`, so it is unambiguously per request: a second
 * research run builds a new one and starts from the full allowance. The
 * pipeline was already bounded this way by the loop's shape — this makes the
 * ceiling explicit, adjustable and visible in the Observatory.
 */
function searchAllowance(total: number) {
	let used = 0;
	return {
		get used() {
			return used;
		},
		get total() {
			return total;
		},
		/** Claim up to `n` searches, returning how many were actually granted. */
		take(n: number): number {
			const granted = Math.max(0, Math.min(n, total - used));
			used += granted;
			return granted;
		}
	};
}

async function runSearches(
	queries: PlannedQuery[],
	searchCfg: WebSearchSettings,
	allowance: ReturnType<typeof searchAllowance>,
	event: (name: string, status: 'ok' | 'error', d: number, detail?: Record<string, unknown>) => void
): Promise<SearchResult[]> {
	const granted = allowance.take(queries.length);
	if (granted < queries.length) {
		event('web_search', 'error', 0, {
			skipped: queries.length - granted,
			reason: 'research search budget spent',
			searchBudget: allowance.total,
			scope: 'research-run'
		});
	}
	const settled = await Promise.allSettled(
		queries.slice(0, granted).map(async ({ q, language }) => {
			const started = Date.now();
			try {
				const outcome = await runWebSearch(q, searchCfg, language);
				event('web_search', 'ok', Date.now() - started, {
					query: q,
					results: outcome.results.length,
					provider: outcome.provider,
					searchesUsed: allowance.used,
					searchBudget: allowance.total,
					scope: 'research-run',
					...(language
						? { language, languageApplied: outcome.languageApplied !== false }
						: {}),
					...(outcome.failedOver ? { failedOver: outcome.failedOver } : {})
				});
				return outcome.results;
			} catch (err) {
				event('web_search', 'error', Date.now() - started, {
					query: q,
					error: String(err),
					scope: 'research-run',
					...(language ? { language } : {})
				});
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
	track: (u: Usage | null) => void,
	defaultLanguage = ''
): Promise<PlannedQuery[]> {
	try {
		const { text, usage } = await choice.adapter.complete(
			{
				modelKey: choice.model.modelKey,
				messages: [
					{
						role: 'user',
						content: `RESEARCH-REVIEW: Given the question "${question}" and these source titles:\n${evidence.map((e) => `[${e.n}] ${e.title}`).join('\n')}\n\nIs the evidence sufficient? ${languageBrief(cfg)} Reply ONLY JSON: {"sufficient":true} or {"sufficient":false,"more_queries":[{"q":"…","language":"de"}]}`
					}
				],
				maxTokens: 300
			},
			AbortSignal.timeout(60_000)
		);
		track(usage);
		const parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
		if (parsed.sufficient) return [];
		// Same tolerance as the planner: follow-ups may come back as bare strings.
		return parseQueries(
			JSON.stringify({ queries: parsed.more_queries ?? [] }),
			cfg.maxQueries,
			defaultLanguage
		);
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
	opts: { userId: string; chatId: string; persist: boolean },
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
			// Same rule as the agent loop: the spend counts, the hidden chat's id
			// does not get to survive here.
			chatId: opts.persist ? opts.chatId : null,
			task: 'deep-research',
			modelKey: choice.model.modelKey,
			promptTokens: usage.promptTokens,
			completionTokens: usage.completionTokens,
			costUsd: cost,
			status
		})
		.run();
}
