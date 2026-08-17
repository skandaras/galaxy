import { randomUUID } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db';
import { usageLog, type AttachmentRef } from '$lib/server/db/schema';
import { appendMessage, getChat, updateChat } from '$lib/server/chats';
import { EFFORT_FRACTION, type ResearchEffort } from '$lib/research-effort';
import type { ModelChoice } from '$lib/server/providers/registry';
import type { Usage } from '$lib/server/providers/types';
import {
	DEFAULT_RESEARCH,
	DEFAULT_WEB_SEARCH,
	getSetting,
	researchRoundCeiling,
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

export interface Evidence {
	n: number;
	title: string;
	url: string;
	excerpt: string;
}

/**
 * Deep research: plan, then rounds of search → read → consolidate, then
 * synthesis.
 *
 * The consolidation between rounds is the point. It reads what the round
 * actually fetched, writes down what that establishes and what is still
 * missing, and derives the next round's queries from the gaps — so a run
 * narrows as it goes instead of searching the same breadth twice. What it
 * writes down is carried forward as a brief, which is also what keeps the
 * context flat: each consolidation sees the brief plus one round of new
 * excerpts, never the whole transcript.
 */
export function startResearchTurn(opts: {
	chatId: string;
	userId: string;
	content: string;
	attachments?: AttachmentRef[];
	/** How much of the admin ceiling this request may spend. */
	effort?: ResearchEffort;
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
		persist,
		opts.effort ?? 'balanced'
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
	persist: boolean,
	effort: ResearchEffort
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
	const budget = roundBudget(cfg, effort);
	const allowance = searchAllowance(budget.searchBudget);
	const defaultLanguage = normaliseLanguage(searchCfg.defaultLanguage);
	const loopStarted = Date.now();

	// 1. Plan search queries
	pushChunk(job, {
		type: 'stage',
		name: 'planning',
		detail: `${effort} · up to ${plural(budget.rounds, 'round')}`
	});
	// An effort level that cannot buy more rounds than the cheapest one is not
	// broken, but it is not what the slider promised either — say which knob
	// actually caps it rather than leaving the control looking inert.
	if (effort !== 'quick' && budget.rounds === roundBudget(cfg, 'quick').rounds) {
		pushChunk(job, {
			type: 'notice',
			text: `Admin allows ${plural(budget.rounds, 'research round')}, so ${effort} and quick run the same. Raise "rounds per run" in Admin → Settings.`
		});
	}
	const plan = await planQueries(choice, systemPrompt, opts.content, cfg, track, defaultLanguage, {
		maxQueries: budget.queriesPerRound,
		signal: job.controller.signal
	});
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

	// 2 + 3. Rounds of search → read → consolidate, narrowing as they go.
	let evidence: Evidence[] = [];
	let brief: ResearchBrief = EMPTY_BRIEF;
	let pending = queries;
	const ranQueries: string[] = [];
	let stopCause: StopCause = 'rounds';
	let roundsUsed = 0;
	let consolidateFailures = 0;

	for (let round = 1; round <= budget.rounds; round++) {
		roundsUsed = round;
		// Research runs its own pipeline rather than runAgentLoop, so it checks
		// for a stop between stages — the gaps here are whole rounds of searching
		// and page fetching, which is exactly what a user wants to cut short.
		if (job.controller.signal.aborted) {
			stopCause = 'cancelled';
			break;
		}
		pending = dedupeQueries(pending, ranQueries).slice(0, budget.queriesPerRound);
		if (!pending.length) {
			stopCause = 'no-gaps';
			break;
		}

		pushChunk(job, {
			type: 'stage',
			name: 'searching',
			detail: `round ${round}/${budget.rounds} · ${plural(pending.length, 'query', 'queries')}`
		});
		const results = await runSearches(pending, searchCfg, allowance, event);
		ranQueries.push(...pending.map((p) => p.q));

		const fresh = await readPages(results, evidence, budget.pagesPerRound, cfg.timeoutMs, event);
		evidence = [...evidence, ...fresh];
		pushChunk(job, {
			type: 'stage',
			name: 'reading',
			detail: `${plural(evidence.length, 'source')}${fresh.length ? ` (+${fresh.length})` : ''}`
		});

		const stop = shouldStopAfterRound({
			round,
			rounds: budget.rounds,
			freshCount: fresh.length,
			evidenceCount: evidence.length,
			searchesLeft: allowance.total - allowance.used,
			aborted: job.controller.signal.aborted
		});
		if (stop) {
			stopCause = stop;
			break;
		}

		pushChunk(job, {
			type: 'stage',
			name: 'consolidating',
			detail: `round ${round} · ${plural(fresh.length, 'new source')}`
		});
		const startedAt = Date.now();
		const outcome = await consolidate({
			choice,
			systemPrompt,
			question: opts.content,
			prior: brief,
			fresh,
			knownSources: evidence.map((e) => e.n),
			ranQueries,
			round,
			rounds: budget.rounds,
			maxQueries: budget.queriesPerRound,
			cfg,
			track,
			defaultLanguage,
			signal: job.controller.signal
		});
		const took = Date.now() - startedAt;

		if (outcome.status === 'cancelled') {
			stopCause = 'cancelled';
			break;
		}
		if (outcome.status === 'ok') {
			// Merged before anything else can end the round, so a consolidation
			// that was useful but incomplete still improves the answer.
			brief = mergeBrief(brief, outcome.brief, round);
			consolidateFailures = 0;
			event('research.consolidate', 'ok', took, {
				round,
				findings: brief.findings.length,
				gaps: brief.gaps.length,
				conflicts: brief.conflicts.length,
				sufficient: brief.sufficient,
				nextQueries: outcome.queries.length
			});
			if (brief.sufficient) {
				stopCause = 'sufficient';
				break;
			}
			pending = outcome.queries;
			if (!pending.length && brief.gaps.length) {
				// Gaps named but no searches proposed: the model described the hole
				// and forgot to dig. Searching the gap text as written beats ending
				// the run one round early.
				pending = gapQueries(brief, budget.queriesPerRound, defaultLanguage);
				pushChunk(job, {
					type: 'notice',
					text: `Round ${round} named ${plural(brief.gaps.length, 'open gap')} but proposed no searches — searching the gaps as written.`
				});
			}
			if (!pending.length) {
				stopCause = 'no-gaps';
				break;
			}
			continue;
		}

		// Everything else is a failed consolidation. It must not fail the job —
		// the sources are already in hand and synthesis can still run — and it
		// must not end the run silently, which is what the old `catch { return [] }`
		// did.
		consolidateFailures++;
		const why = consolidateFailureReason(outcome);
		event('research.consolidate', 'error', took, { round, reason: outcome.status });
		const fallback = dedupeQueries(
			gapQueries(brief, budget.queriesPerRound, defaultLanguage),
			ranQueries
		);
		// A lost round is not a lost run, but twice in a row means the model
		// cannot do this job and another round would only burn the allowance.
		if (consolidateFailures >= 2 || !fallback.length) {
			pushChunk(job, {
				type: 'notice',
				text: `Consolidation ${why} in round ${round}; answering from the ${plural(evidence.length, 'source')} already gathered.`
			});
			stopCause = 'consolidation-failed';
			break;
		}
		pushChunk(job, {
			type: 'notice',
			text: `Consolidation ${why} in round ${round}; continuing from the previous brief's open gaps.`
		});
		pending = fallback;
	}

	const stopNotice = STOP_NOTICE[stopCause]?.({
		round: roundsUsed,
		rounds: budget.rounds,
		sources: evidence.length,
		searches: allowance.total
	});
	if (stopNotice) pushChunk(job, { type: 'notice', text: stopNotice });
	if (brief.round) {
		pushChunk(job, { type: 'notice', text: briefSummary(brief) });
	}
	event('research.rounds', stopCause === 'consolidation-failed' ? 'error' : 'ok', Date.now() - loopStarted, {
		effort,
		roundsUsed,
		roundsAllowed: budget.rounds,
		roundCeiling: budget.roundCeiling,
		stopCause,
		sources: evidence.length,
		findings: brief.findings.length,
		gaps: brief.gaps.length,
		searchesUsed: allowance.used,
		searchBudget: allowance.total
	});

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
							`RESEARCH-SYNTHESIS: Answer the question using the numbered sources. Cite as [n] inline. Be thorough but structured. If sources conflict or are thin, say so. The brief is what earlier rounds established from these same sources — treat it as notes, not as an answer, and verify anything load-bearing against the excerpts. Anything listed as an open gap is unresolved: say so rather than filling it in.`,
							`Question: ${opts.content}`,
							`--- BRIEF ---`,
							brief.round ? briefToPrompt(brief) : '(single-pass run — no brief)',
							`--- SOURCES ---`,
							evidence.length
								? evidenceToPrompt(
										evidence,
										evidenceExcerptBudget(
											evidence.length,
											SYNTHESIS_EVIDENCE_CHARS,
											SYNTHESIS_MIN_PER_SOURCE,
											SYNTHESIS_MAX_PER_SOURCE
										)
									)
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
/** Consolidation writes a brief rather than a list, so it needs more room than
 *  the planner. Same retry, for the same reasoning models. */
const CONSOLIDATE_TOKENS = 900;
const CONSOLIDATE_TOKENS_RETRY = 4000;
/** Deadline for one planning or consolidation call. */
const CALL_TIMEOUT_MS = 60_000;

/**
 * Characters of *new* excerpt handed to one consolidation call.
 *
 * With the prior brief capped too (see MAX_FINDINGS and friends), every
 * consolidation prompt lands around the same size whether it is round 2 or
 * round 8 — the brief is carried instead of the transcript precisely so this
 * stays flat rather than growing with the round count.
 */
const CONSOLIDATE_INPUT_CHARS = 12_000;
const CONSOLIDATE_MIN_PER_SOURCE = 600;
const CONSOLIDATE_MAX_PER_SOURCE = 2_400;

/**
 * Characters of excerpt handed to synthesis, across every source.
 *
 * Synthesis used to inline every excerpt whole, which was fine at two rounds of
 * six pages and is not at eight: the ceiling is what stops raising the round
 * budget from quietly doubling the largest prompt in the pipeline. The
 * per-source maximum matches fetchPageText's own clip, so a small run is
 * unaffected.
 */
const SYNTHESIS_EVIDENCE_CHARS = 60_000;
const SYNTHESIS_MIN_PER_SOURCE = 800;
const SYNTHESIS_MAX_PER_SOURCE = 6_000;

/** Brief caps. These are what bound the carried context across rounds. */
const MAX_FINDINGS = 12;
const MAX_GAPS = 6;
const MAX_CONFLICTS = 4;
const CLAIM_CHARS = 400;
const GAP_CHARS = 240;

/** "1 source" / "3 sources", so notices don't read like machine output. */
function plural(n: number, one: string, many = `${one}s`): string {
	return `${n} ${n === 1 ? one : many}`;
}

/**
 * How much of the admin's ceiling one effort level may spend.
 *
 * Rounded up, not down: a fraction of a small ceiling must still buy a round,
 * or the lowest level would resolve to nothing on a conservative install.
 */
export interface RoundBudget {
	effort: ResearchEffort;
	/** Total search → read rounds including the first. Always at least 1. */
	rounds: number;
	/** The admin ceiling, so a collapsed range can name the knob that caps it. */
	roundCeiling: number;
	queriesPerRound: number;
	pagesPerRound: number;
	/** Searches the whole run may make, across every round. */
	searchBudget: number;
}

export function roundBudget(cfg: ResearchSettings, effort: ResearchEffort): RoundBudget {
	const fraction = EFFORT_FRACTION[effort] ?? EFFORT_FRACTION.balanced;
	const scale = (ceiling: number, floor: number) =>
		Math.min(ceiling, Math.max(Math.min(floor, ceiling), Math.ceil(ceiling * fraction)));

	const roundCeiling = researchRoundCeiling(cfg);
	const maxQueries = Math.max(1, Math.floor(cfg.maxQueries || 1));
	const maxPages = Math.max(1, Math.floor(cfg.maxPages || 1));
	const maxSearches = Math.max(1, Math.floor(cfg.maxSearchesPerRun || maxQueries));

	const rounds = scale(roundCeiling, 1);
	const queriesPerRound = scale(maxQueries, 2);
	const pagesPerRound = scale(maxPages, 2);
	return {
		effort,
		rounds,
		roundCeiling,
		queriesPerRound,
		pagesPerRound,
		// Two independent ceilings — what these rounds could actually spend, and
		// the admin's absolute per-run cap. Whichever binds first wins.
		searchBudget: Math.max(1, Math.min(rounds * queriesPerRound, scale(maxSearches, 1)))
	};
}

/** A claim plus the sources carrying it, so synthesis can cite it. */
export interface BriefFinding {
	claim: string;
	sources: number[];
}

/**
 * What the run has established so far, carried between rounds.
 *
 * This is the thing the old pipeline had no equivalent of. Its review step saw
 * only source titles and kept nothing, so round two searched the same breadth
 * as round one; carrying findings and gaps is what lets a round narrow.
 */
export interface ResearchBrief {
	/** Round it was last updated in; 0 means it has never been consolidated. */
	round: number;
	findings: BriefFinding[];
	/** What the question still needs, each written so a search can be made of it. */
	gaps: string[];
	conflicts: string[];
	/** The model's own verdict. True ends the loop before the round ceiling. */
	sufficient: boolean;
}

export const EMPTY_BRIEF: ResearchBrief = Object.freeze({
	round: 0,
	findings: [],
	gaps: [],
	conflicts: [],
	sufficient: false
});

export type StopCause =
	| 'rounds'
	| 'cancelled'
	| 'no-sources'
	| 'no-new-sources'
	| 'search-budget'
	| 'sufficient'
	| 'no-gaps'
	| 'consolidation-failed';

/**
 * Whether the round just finished should be the last one.
 *
 * Pure and exported so the loop's exit conditions are testable without a job,
 * a database or a network — the old round loop had no test at all.
 */
export function shouldStopAfterRound(s: {
	round: number;
	rounds: number;
	freshCount: number;
	evidenceCount: number;
	searchesLeft: number;
	aborted: boolean;
}): StopCause | null {
	if (s.aborted) return 'cancelled';
	if (!s.evidenceCount) return 'no-sources';
	if (s.round >= s.rounds) return 'rounds';
	// Every hit was an address already read, so another round would consolidate
	// nothing new and search from the same place.
	if (!s.freshCount) return 'no-new-sources';
	if (s.searchesLeft <= 0) return 'search-budget';
	return null;
}

/**
 * The one line that explains why the loop ended.
 *
 * 'rounds' and 'cancelled' are absent on purpose: the stage trail already shows
 * the last round, and stopping already pushes its own notice. 'no-sources' is
 * absent because the synthesis block below has always had a better-worded one.
 */
const STOP_NOTICE: Partial<
	Record<StopCause, (s: { round: number; rounds: number; sources: number; searches: number }) => string>
> = {
	'no-new-sources': (s) =>
		`Round ${s.round} found nothing that had not already been read — moving to the answer.`,
	'search-budget': (s) =>
		`Used all ${plural(s.searches, 'search')} allowed for this run before the round budget ran out. Raise "searches per run" in Admin → Settings.`,
	sufficient: (s) => `Evidence judged sufficient after ${s.round} of ${s.rounds} rounds.`,
	'no-gaps': (s) => `No open gaps left to search after ${plural(s.round, 'round')}.`
};

function briefSummary(brief: ResearchBrief): string {
	const parts = [plural(brief.findings.length, 'finding'), plural(brief.gaps.length, 'open gap')];
	if (brief.conflicts.length) parts.push(plural(brief.conflicts.length, 'conflict'));
	return `Brief after ${plural(brief.round, 'round')}: ${parts.join(', ')}.`;
}

function consolidateFailureReason(outcome: ConsolidateOutcome): string {
	switch (outcome.status) {
		case 'unparseable':
			return 'returned no usable JSON';
		case 'empty':
			return outcome.reasonedOnly
				? 'spent its whole token budget reasoning'
				: 'returned nothing';
		case 'timeout':
			return 'timed out';
		default:
			return `failed (${outcome.status === 'error' ? outcome.error : outcome.status})`;
	}
}

/**
 * Characters of excerpt each source gets, given a total to share out.
 *
 * Capped both ways: the floor keeps a source that made the cut worth including,
 * and the ceiling stops a two-source run from being padded past what was
 * actually fetched.
 */
export function evidenceExcerptBudget(
	count: number,
	total: number,
	min: number,
	max: number
): number {
	if (count <= 0) return max;
	return Math.min(max, Math.max(min, Math.floor(total / count)));
}

export function clipExcerpt(text: string, chars: number): string {
	return text.length <= chars ? text : `${text.slice(0, chars).trimEnd()}\n…[clipped]`;
}

function evidenceToPrompt(evidence: Evidence[], perSource: number): string {
	return evidence
		.map((e) => `[${e.n}] ${e.title} (${e.url})\n${clipExcerpt(e.excerpt, perSource)}`)
		.join('\n\n');
}

/** The brief as the model sees it, both when consolidating and synthesising. */
export function briefToPrompt(brief: ResearchBrief): string {
	if (!brief.round || (!brief.findings.length && !brief.gaps.length)) {
		return '(nothing established yet — this is the first consolidation)';
	}
	return [
		'Findings:',
		...brief.findings.map(
			(f) => `- ${f.claim}${f.sources.length ? ` [${f.sources.join(',')}]` : ''}`
		),
		brief.gaps.length ? 'Open gaps:' : '',
		...brief.gaps.map((g) => `- ${g}`),
		brief.conflicts.length ? 'Conflicts:' : '',
		...brief.conflicts.map((c) => `- ${c}`)
	]
		.filter(Boolean)
		.join('\n');
}

const queryKey = (q: string) => q.toLowerCase().replace(/\s+/g, ' ').trim();

/** Drop follow-ups that repeat a search this run has already made. */
export function dedupeQueries(next: PlannedQuery[], ran: string[]): PlannedQuery[] {
	const seen = new Set(ran.map(queryKey));
	const out: PlannedQuery[] = [];
	for (const q of next) {
		const key = queryKey(q.q);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		out.push(q);
	}
	return out;
}

/**
 * The brief's own gaps, as searches.
 *
 * The fallback for a model that named what is missing and then proposed no
 * queries for it — the gaps are already required to be written specifically
 * enough to search as they stand.
 */
export function gapQueries(brief: ResearchBrief, max: number, language = ''): PlannedQuery[] {
	return brief.gaps.slice(0, max).map((gap) => ({ q: gap.slice(0, GAP_CHARS), language }));
}

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

/**
 * Deadline for a model call, cancelled early when the job is stopped.
 *
 * Planning and consolidation used to pass a bare timeout, so pressing Stop left
 * a call running for up to a minute before anything noticed.
 */
function callSignal(signal?: AbortSignal): AbortSignal {
	const deadline = AbortSignal.timeout(CALL_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

export async function planQueries(
	choice: ModelChoice,
	systemPrompt: string,
	question: string,
	cfg: ResearchSettings,
	track: (u: Usage | null) => void,
	defaultLanguage = '',
	opts: { maxQueries?: number; signal?: AbortSignal } = {}
): Promise<PlanOutcome> {
	const maxQueries = Math.max(1, opts.maxQueries ?? cfg.maxQueries);
	const ask = (maxTokens: number) =>
		choice.adapter.complete(
			{
				modelKey: choice.model.modelKey,
				messages: [
					{ role: 'system', content: systemPrompt },
					{
						role: 'user',
						content: `RESEARCH-PLAN: Produce up to ${maxQueries} focused web-search queries for researching this question. Cover its distinct angles rather than rephrasing it — later rounds will narrow onto whatever these leave open. ${languageBrief(cfg)} Reply ONLY with JSON: {"queries":[{"q":"…","language":"de"}]} — use "" for language when no constraint is wanted.\n\nQuestion: ${question}`
					}
				],
				maxTokens
			},
			callSignal(opts.signal)
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
		const queries = parseQueries(res.text, maxQueries, defaultLanguage);
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
	limit: number,
	timeoutMs: number,
	event: (name: string, status: 'ok' | 'error', d: number, detail?: Record<string, unknown>) => void
): Promise<Evidence[]> {
	const known = new Set(existing.map((e) => e.url));
	const toRead = results.filter((r) => !known.has(r.url)).slice(0, limit);
	let n = existing.length;
	const settled = await Promise.allSettled(
		toRead.map(async (r) => {
			const started = Date.now();
			try {
				const excerpt = await fetchPageText(r.url, timeoutMs);
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

/**
 * Update the brief from a round's new sources, and decide what to search next.
 *
 * This replaces a review step that saw only source *titles* and kept nothing
 * between rounds. Reading the excerpts is what makes narrowing possible at all:
 * the queries it returns come from gaps it identified in the text, not from
 * rephrasing the original question.
 */
export type ConsolidateOutcome =
	| { status: 'ok'; brief: Omit<ResearchBrief, 'round'>; queries: PlannedQuery[] }
	| { status: 'unparseable'; sample: string }
	| { status: 'empty'; reasonedOnly: boolean }
	| { status: 'timeout' }
	| { status: 'error'; error: string }
	| { status: 'cancelled' };

export async function consolidate(args: {
	choice: ModelChoice;
	systemPrompt: string;
	question: string;
	prior: ResearchBrief;
	/** Only this round's new sources — the brief stands in for earlier ones. */
	fresh: Evidence[];
	knownSources: number[];
	ranQueries: string[];
	round: number;
	rounds: number;
	maxQueries: number;
	cfg: ResearchSettings;
	track: (u: Usage | null) => void;
	defaultLanguage?: string;
	signal?: AbortSignal;
}): Promise<ConsolidateOutcome> {
	const { choice, cfg, prior, fresh, track } = args;
	const perSource = evidenceExcerptBudget(
		fresh.length,
		CONSOLIDATE_INPUT_CHARS,
		CONSOLIDATE_MIN_PER_SOURCE,
		CONSOLIDATE_MAX_PER_SOURCE
	);
	const content = [
		`RESEARCH-CONSOLIDATE — round ${args.round} of ${args.rounds}.`,
		`Question: ${args.question}`,
		`--- BRIEF SO FAR ---`,
		briefToPrompt(prior),
		`--- NEW SOURCES THIS ROUND ---`,
		evidenceToPrompt(fresh, perSource),
		[
			`Update the brief from what these sources actually say, not from what you already believe.`,
			`findings: everything the evidence now establishes, each with the source numbers supporting it. Carry forward earlier findings that still hold; correct or drop any these sources contradict. Source numbers must come from: ${args.knownSources.join(', ')}.`,
			`gaps: what the question still needs and no source has answered. Write each one specifically enough that a web search can be made of it as it stands.`,
			`conflicts: where sources disagree, naming both numbers.`,
			`sufficient: true only when the remaining gaps could not change the answer.`,
			`next_queries: up to ${args.maxQueries} searches that would close the biggest gaps. Do not repeat these, which have already been run: ${args.ranQueries.map((q) => `"${q}"`).join(', ')}. ${languageBrief(cfg)}`,
			`Reply ONLY with JSON: {"findings":[{"claim":"…","sources":[1,4]}],"gaps":["…"],"conflicts":["…"],"sufficient":false,"next_queries":[{"q":"…","language":"de"}]}`
		].join(' ')
	].join('\n\n');

	const ask = (maxTokens: number) =>
		choice.adapter.complete(
			{
				modelKey: choice.model.modelKey,
				// The old review call sent no system prompt at all, unlike planning
				// and synthesis — part of why its judgement was poor.
				messages: [
					{ role: 'system', content: args.systemPrompt },
					{ role: 'user', content }
				],
				maxTokens
			},
			callSignal(args.signal)
		);

	let res;
	try {
		res = await ask(CONSOLIDATE_TOKENS);
		track(res.usage);
		// Same reasoning-model allowance the planner makes: a model that spent the
		// first budget thinking gets one retry with real headroom.
		if (!res.text.trim() && (res.reasonedOnly || res.finishReason === 'length')) {
			res = await ask(CONSOLIDATE_TOKENS_RETRY);
			track(res.usage);
		}
	} catch (err) {
		if (args.signal?.aborted) return { status: 'cancelled' };
		if (err instanceof Error && err.name === 'TimeoutError') return { status: 'timeout' };
		return { status: 'error', error: String(err) };
	}

	if (!res.text.trim()) return { status: 'empty', reasonedOnly: Boolean(res.reasonedOnly) };
	const parsed = parseBrief(res.text, {
		knownSources: args.knownSources,
		maxQueries: args.maxQueries,
		fallbackLanguage: args.defaultLanguage ?? ''
	});
	if (!parsed) return { status: 'unparseable', sample: res.text.slice(0, 200) };
	return { status: 'ok', brief: parsed.brief, queries: parsed.queries };
}

/**
 * Parse a consolidation.
 *
 * Same tolerance `parseQueries` shows: a finding that came back as a bare
 * string is a model ignoring the shape, not a failed round, so it becomes a
 * claim with no sources rather than being dropped. Returns null only when there
 * is genuinely nothing to carry forward — the caller treats that as a failed
 * round and says so, instead of ending the run in silence.
 */
export function parseBrief(
	text: string,
	opts: { knownSources: number[]; maxQueries: number; fallbackLanguage?: string }
): { brief: Omit<ResearchBrief, 'round'>; queries: PlannedQuery[] } | null {
	const start = text.indexOf('{');
	const end = text.lastIndexOf('}');
	if (start === -1 || end <= start) return null;
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(text.slice(start, end + 1));
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== 'object') return null;

	const known = new Set(opts.knownSources);
	const str = (v: unknown, cap: number): string =>
		typeof v === 'string' && v.trim() ? v.trim().slice(0, cap) : '';
	const list = (v: unknown, cap: number, max: number): string[] =>
		(Array.isArray(v) ? v : [])
			.map((entry) => str(entry, cap))
			.filter(Boolean)
			.slice(0, max);

	const findings: BriefFinding[] = [];
	for (const raw of Array.isArray(parsed.findings) ? parsed.findings : []) {
		const record = raw as { claim?: unknown; sources?: unknown };
		const claim = typeof raw === 'string' ? str(raw, CLAIM_CHARS) : str(record?.claim, CLAIM_CHARS);
		if (!claim) continue;
		const sources = (Array.isArray(record?.sources) ? record.sources : [])
			.map(Number)
			// A citation to a source that does not exist is worse than none: it
			// would survive into synthesis and read as sourced.
			.filter((n: number) => Number.isInteger(n) && known.has(n));
		findings.push({ claim, sources: [...new Set(sources)] });
		if (findings.length >= MAX_FINDINGS) break;
	}

	const gaps = list(parsed.gaps, GAP_CHARS, MAX_GAPS);
	const sufficient = parsed.sufficient === true;
	// Nothing established, nothing missing, and not called done — that is not a
	// brief, it is a model that answered a different question.
	if (!findings.length && !gaps.length && !sufficient) return null;

	return {
		brief: { findings, gaps, conflicts: list(parsed.conflicts, GAP_CHARS, MAX_CONFLICTS), sufficient },
		// Routed through parseQueries so follow-ups get the same shape tolerance
		// and language handling as the plan.
		queries: parseQueries(
			JSON.stringify({ queries: parsed.next_queries ?? parsed.more_queries ?? [] }),
			opts.maxQueries,
			opts.fallbackLanguage ?? ''
		)
	};
}

/**
 * Fold a round's consolidation into the brief.
 *
 * The model owns the brief, so its findings come first and a prior one survives
 * only where it was not restated — otherwise a correction in round 3 would sit
 * below the stale claim from round 2 and both would reach synthesis.
 */
export function mergeBrief(
	prev: ResearchBrief,
	next: Omit<ResearchBrief, 'round'>,
	round: number
): ResearchBrief {
	const key = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
	const merged: BriefFinding[] = [];
	const seen = new Set<string>();
	for (const finding of [...next.findings, ...prev.findings]) {
		const k = key(finding.claim);
		if (seen.has(k)) continue;
		seen.add(k);
		merged.push(finding);
		if (merged.length >= MAX_FINDINGS) break;
	}
	return {
		round,
		findings: merged,
		// A shorter gap list is progress. An empty one from a model that also said
		// "not sufficient" is a formatting slip, and dropping the gaps there would
		// end the run a round early for no reason.
		gaps: next.gaps.length || next.sufficient ? next.gaps : prev.gaps,
		conflicts: next.conflicts.length ? next.conflicts : prev.conflicts,
		sufficient: next.sufficient
	};
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
