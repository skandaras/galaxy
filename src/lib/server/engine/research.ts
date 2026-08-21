import { randomUUID } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db';
import { usageLog, type AttachmentRef } from '$lib/server/db/schema';
import { appendMessage, getChat, getMessages, updateChat, type StoredMessage } from '$lib/server/chats';
import { EFFORT_FRACTION, type ResearchEffort } from '$lib/research-effort';
import type { ModelChoice } from '$lib/server/providers/registry';
import { isRetryable, type Usage } from '$lib/server/providers/types';
import {
	DEFAULT_RESEARCH,
	webSearchSettings,
	getSetting,
	researchRoundCeiling,
	type ResearchSettings,
	type WebSearchSettings
} from '$lib/server/settings';
import { assertBudget } from './budget';
import { withDocumentText } from './context';
import { bootstrapContext } from './tools/knowledge';
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
import type { RunToolCall } from '$lib/run-timeline';
import { streamWithIdleTimeout } from './loop';
import {
	StreamTimeoutError,
	type CompletionResult,
	type ProviderMessage
} from '$lib/server/providers/types';
import {
	BROWSER_UA,
	createPacer,
	displayRows,
	normaliseLanguage,
	runPaced,
	runWebSearch,
	type Pacer,
	type SearchResult
} from './tools/web-search';

export interface Evidence {
	n: number;
	title: string;
	url: string;
	excerpt: string;
	/**
	 * Where the excerpt came from. 'snippet' means the page could not be read
	 * and this is the search engine's ~150-character summary — which synthesis
	 * used to cite in exactly the same voice as a page it had read in full.
	 *
	 * Required rather than optional: there are only two construction sites, and
	 * making the compiler force the decision is the point.
	 */
	kind: 'page' | 'snippet';
	/** Why the page could not be read. Only set when `kind` is 'snippet'. */
	failure?: FetchFailure;
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

	// Read before this turn's message is appended, so the framing step sees the
	// conversation as it stood when the question was asked.
	const history = framingHistory(getMessages(chat.id));

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
	const asked = withDocumentText(chat.id, opts.content, opts.attachments);

	void runResearch(
		job,
		{ ...opts, content: asked },
		choice,
		// Same bootstrap the chat loop gets: memory, the skills index, the
		// library and boards. Research had none of it, so it could not know
		// something the user had already told the platform.
		(cfg?.systemPrompt ?? '') + bootstrapContext(opts.userId),
		searchCfg,
		persist,
		opts.effort ?? 'balanced',
		{ history, compactSummary: chat.compactSummary }
	).catch((err) => {
		if (job.status === 'running') failJob(job, String(err));
	});
	return job;
}

function resolveSearchCfg(): WebSearchSettings {
	const research = getSetting<ResearchSettings>('research', DEFAULT_RESEARCH);
	const base = webSearchSettings();
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
	effort: ResearchEffort,
	conversation: { history: StoredMessage[]; compactSummary?: string | null }
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
	const pacer = createPacer(searchCfg.provider);
	const defaultLanguage = normaliseLanguage(searchCfg.defaultLanguage);
	const loopStarted = Date.now();

	// 0. Resolve the question against the conversation.
	//
	// Skipped outright on the first message of a chat: it is already standalone,
	// so a simple run pays nothing and never shows a stage it did not need.
	// The framed question is what gets *searched*; `asked` is what the run stays
	// answerable to. Keeping both means a framing that narrowed or mis-resolved
	// the request is visible to every later round instead of silently becoming
	// the whole truth.
	const asked = opts.content;
	let question = asked;
	let background = '';
	if (conversation.history.length) {
		pushChunk(job, { type: 'stage', name: 'framing' });
		const framed = await frameQuestion({
			choice,
			systemPrompt,
			message: asked,
			history: conversation.history,
			compactSummary: conversation.compactSummary,
			track,
			signal: job.controller.signal
		});
		if (framed.fellBack) {
			pushChunk(job, {
				type: 'notice',
				text: `Could not read the question against the conversation (${framed.fellBack}) — researching the message as written, so anything it refers back to may be missed.`
			});
			event('research.frame', 'error', 0, { fellBack: framed.fellBack });
		} else {
			question = framed.question;
			background = framed.background;
			event('research.frame', 'ok', 0, { question, hasBackground: Boolean(background) });
			// Worth showing: it is what the run is actually about, and a bad
			// framing is otherwise invisible until the sources look wrong.
			pushChunk(job, { type: 'notice', text: `Researching: ${question}` });
		}
	}

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
	const plan = await planQueries(
		choice,
		systemPrompt,
		background ? `${question}\n\nAlready established, do not re-research: ${background}` : question,
		cfg,
		track,
		defaultLanguage,
		{ maxQueries: budget.queriesPerRound, signal: job.controller.signal }
	);
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
	/**
	 * Every query the run made, with what it found.
	 *
	 * The live boxes are cleared with the timeline the moment the run ends, and
	 * research — unlike a chat turn — wrote no trace at all, so what it searched
	 * was gone as soon as it finished answering. One tool call per query, which
	 * is the shape `RunTimeline` already draws.
	 */
	const searchTrace: RunToolCall[] = [];

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
		const results = await runSearches(
			pending,
			searchCfg,
			allowance,
			event,
			pacer,
			(p) => {
				// A run that suddenly takes twice as long should say why, once.
				pushChunk(job, {
					type: 'notice',
					text: `Search engines are rate-limiting this address — slowing to one search at a time (${Math.round(p.pacing.gapMs / 100) / 10}s apart) for the rest of this run.`
				});
				event('search_throttled', 'ok', 0, {
					scope: 'research-run',
					round,
					gapMs: p.pacing.gapMs,
					concurrency: p.pacing.concurrency
				});
			},
			// One box per query, as it lands. A round used to be a single opaque
			// line naming how many queries it was about to run; this shows which
			// ones, and what each of them actually turned up.
			({ q, language }, found, status) => {
				const results = displayRows(found);
				searchTrace.push({
					name: 'web_search',
					summary: language ? `${q} [${language}]` : q,
					status,
					results
				});
				pushChunk(job, {
					type: 'search',
					query: q,
					...(language ? { language } : {}),
					...(status === 'error' ? { failed: true } : {}),
					results
				});
			}
		);
		ranQueries.push(...pending.map((p) => p.q));

		const fresh = await readPages(results, evidence, budget.pagesPerRound, cfg.timeoutMs, event, {
			onTriage: ({ candidates, pool, opened }) =>
				pushChunk(job, {
					type: 'stage',
					name: 'triage',
					detail: `${candidates} found → ${pool} shortlisted → ${opened} opened`
				}),
			// Gated on open gaps as well as pool size: that means round two or
			// later, where "which of these answers *this* hole" is a judgement
			// grounded in something the run actually found.
			chooser:
				cfg.modelTriage && brief.gaps.length
					? (pool, max) =>
							triagePages({
								choice,
								systemPrompt,
								question,
								gaps: brief.gaps,
								pool,
								limit: max,
								track,
								signal: job.controller.signal
							})
					: undefined
		});
		evidence = [...evidence, ...fresh];
		const freshSnippets = fresh.filter((e) => e.kind === 'snippet').length;
		pushChunk(job, {
			type: 'stage',
			name: 'reading',
			// Snippet-only counts are called out here because they are the
			// difference between a round that read four pages and one that only
			// saw four search results.
			detail: `${plural(evidence.length, 'source')}${
				fresh.length
					? ` (+${fresh.length - freshSnippets} read${freshSnippets ? `, ${freshSnippets} snippet only` : ''})`
					: ''
			}`
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
		const runConsolidation = () =>
			consolidate({
				choice,
				systemPrompt,
				asked,
				question,
				background,
				prior: brief,
				fresh,
				allEvidence: evidence,
				ranQueries,
				round,
				rounds: budget.rounds,
				maxQueries: budget.queriesPerRound,
				cfg,
				track,
				defaultLanguage,
				signal: job.controller.signal
			});
		let outcome = await runConsolidation();
		// Round one gets a second attempt on the same sources.
		//
		// Every other round survives a failed consolidation by searching the
		// previous brief's open gaps — but before the first consolidation there is
		// no brief, so there are no gaps, and the failure branch below has nothing
		// to continue from. That made one flaky consolidation in round one end a
		// four-round run, which is the opposite of what "a lost round is not a lost
		// run" was meant to guarantee. There is nothing new to search here, but the
		// sources are already in hand: reading them again is the whole retry.
		if (round === 1 && outcome.status !== 'ok' && outcome.status !== 'cancelled') {
			pushChunk(job, {
				type: 'notice',
				text: `Consolidation ${consolidateFailureReason(outcome)} in round 1; trying once more on the same sources.`
			});
			event('research.consolidate', 'error', Date.now() - startedAt, {
				round,
				reason: outcome.status,
				retrying: true
			});
			outcome = await runConsolidation();
		}
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
		pagesRead: evidence.filter((e) => e.kind === 'page').length,
		snippetOnly: evidence.filter((e) => e.kind === 'snippet').length,
		// Per-cause counts, so "the web refused us" and "the material is not
		// there" stop looking identical in the Observatory.
		failures: countFailures(evidence),
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
							`RESEARCH-SYNTHESIS: Answer the question using the numbered sources. Cite as [n] inline. Be thorough but structured. If sources conflict or are thin, say so. A source marked SEARCH SNIPPET ONLY was never read: prefer a read source for anything load-bearing, and say plainly when a claim rests only on a snippet. The brief is what earlier rounds established from these same sources — treat it as notes, not as an answer, and verify anything load-bearing against the excerpts. Anything listed as an open gap is unresolved: say so rather than filling it in.`,
							`Question: ${question}`,
							background ? `--- FROM THE CONVERSATION ---\n${background}` : '',
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
						]
							.filter(Boolean)
							.join('\n\n')
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
		const sources = sourcesFooter(evidence);
		answer += sources;
		pushChunk(job, { type: 'delta', text: sources });
	}

	const saved = appendMessage(opts.chatId, {
		role: 'assistant',
		content: answer,
		modelKey: choice.model.modelKey,
		trace: searchTrace.length
			? {
					summary: `${plural(roundsUsed, 'round')} · ${plural(searchTrace.length, 'search', 'searches')} · ${plural(evidence.length, 'source')}`,
					steps: [
						{
							id: 'searches',
							label: plural(searchTrace.length, 'search', 'searches'),
							status: 'ok',
							toolCalls: searchTrace
						}
					]
				}
			: null
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
/** Characters of page text one source contributes, after extraction. */
export const PAGE_TEXT_CHARS = 6_000;
// Equal to the page clip on purpose: a small run's excerpts reach synthesis
// exactly as they were fetched.
const SYNTHESIS_MAX_PER_SOURCE = PAGE_TEXT_CHARS;

/** Brief caps. These are what bound the carried context across rounds. */
// Duplicates no longer consume the cap now that a round replaces the brief
// rather than merging into it.
const MAX_FINDINGS = 16;
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
	/**
	 * Whether anything backing this claim was actually read.
	 *
	 * Without it, "do not rest a finding on a search snippet" was enforceable
	 * only in the round the source arrived: one round later a snippet-only claim
	 * and a fully-read one were typographically identical in the brief, and a
	 * thin claim could harden into an established finding on its way to the
	 * answer.
	 */
	support: 'read' | 'snippet';
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
		`Used all ${plural(s.searches, 'search', 'searches')} allowed for this run before the round budget ran out. Raise "searches per run" in Admin → Settings.`,
	sufficient: (s) => `Evidence judged sufficient after ${s.round} of ${s.rounds} rounds.`,
	'no-gaps': (s) => `No open gaps left to search after ${plural(s.round, 'round')}.`
};

/** How many sources fell back for each reason, for the run's rollup event. */
export function countFailures(evidence: Evidence[]): Record<string, number> {
	const out: Record<string, number> = {};
	for (const e of evidence) {
		if (e.kind === 'page') continue;
		const key = e.failure ?? 'unknown';
		out[key] = (out[key] ?? 0) + 1;
	}
	return out;
}

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

/** The marker consolidation and synthesis both key off. */
function snippetMark(e: Evidence): string {
	return e.kind === 'page'
		? ''
		: ` — SEARCH SNIPPET ONLY (${e.failure ? FETCH_FAILURE_TEXT[e.failure] : 'the page could not be read'})`;
}

function evidenceToPrompt(evidence: Evidence[], perSource: number): string {
	return evidence
		.map(
			(e) =>
				`[${e.n}] ${e.title} (${e.url})${snippetMark(e)}\n${clipExcerpt(e.excerpt, perSource)}`
		)
		.join('\n\n');
}

/**
 * Every source gathered so far, one compact line each.
 *
 * Consolidation is handed only the round's *new* excerpts, so before this a
 * carried finding like `- Meeple Mountain is an AU/NZ review site [4]` reached
 * later rounds with source 4 appearing nowhere except a list of legal integers.
 * The model could not check the citation, could not find a conflict against it,
 * and could only restate it — which is how a claim taken from a search snippet
 * hardened into an established finding.
 *
 * Titles are clipped and excerpts omitted, so 24 sources cost well under 2 KB
 * and the flat-context invariant holds.
 */
export function sourceRegister(evidence: Evidence[]): string {
	if (!evidence.length) return '(no sources yet)';
	return evidence
		.map((e) => {
			const host = hostOf(e.url) || e.url;
			const title = e.title.length > REGISTER_TITLE_CHARS
				? `${e.title.slice(0, REGISTER_TITLE_CHARS).trimEnd()}…`
				: e.title;
			const status =
				e.kind === 'page'
					? 'read in full'
					: `SEARCH SNIPPET ONLY (${e.failure ? FETCH_FAILURE_TEXT[e.failure] : 'not read'})`;
			return `[${e.n}] ${title} — ${host} — ${status}`;
		})
		.join('\n');
}

const REGISTER_TITLE_CHARS = 80;

function hostOf(rawUrl: string): string {
	try {
		return new URL(rawUrl).hostname.replace(/^www\./, '');
	} catch {
		return '';
	}
}

/**
 * The reader-facing source list. Extracted from the inline map it used to be
 * so its shape is testable without running a job.
 */
export function sourcesFooter(evidence: Evidence[]): string {
	if (!evidence.length) return '';
	return [
		'',
		'',
		'**Sources**',
		...evidence.map(
			(e) =>
				`${e.n}. [${e.title}](${e.url})${
					e.kind === 'snippet'
						? ` — search snippet only, ${e.failure ? FETCH_FAILURE_TEXT[e.failure] : 'the page could not be read'}`
						: ''
				}`
		)
	].join('\n');
}

/** The brief as the model sees it, both when consolidating and synthesising. */
export function briefToPrompt(brief: ResearchBrief): string {
	if (!brief.round || (!brief.findings.length && !brief.gaps.length)) {
		return '(nothing established yet — this is the first consolidation)';
	}
	return [
		'Findings:',
		...brief.findings.map(
			(f) =>
				`- ${f.claim}${f.sources.length ? ` [${f.sources.join(',')}]` : ''}${
					f.support === 'snippet' ? ' (snippet-only support)' : ''
				}`
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

/** Framing budget, with the planner's retry for reasoning models. */
const FRAME_TOKENS = 500;
const FRAME_TOKENS_RETRY = 4000;
/** Turns of history the framing step reads, and how much of each. */
const FRAME_TURNS = 8;
const FRAME_TURN_CHARS = 1_200;

export interface Framing {
	/** Self-contained research question, readable without the conversation. */
	question: string;
	/** What the conversation already established. Empty when there was none. */
	background: string;
	/** Set when the model produced nothing usable and the message stands in. */
	fellBack: 'empty' | 'unparseable' | 'error' | null;
}

/** The recent conversation, oldest first, clipped and without tool exchanges. */
export function framingHistory(all: StoredMessage[]): StoredMessage[] {
	return all.filter((m) => m.role !== 'tool').slice(-FRAME_TURNS);
}

/**
 * Restate the conversation and the new message as a question that stands alone.
 *
 * Research builds its own prompts rather than replaying the transcript, which
 * meant a follow-up like "do another round, but focus on X" was researched as
 * exactly that sentence — with no idea what "another round" was about. Framing
 * resolves the referents once, cheaply, and everything downstream gets a
 * question that makes sense on its own.
 *
 * A previous research answer is itself in the history, findings and sources
 * included, so this is also how a follow-up inherits the last run's results
 * without any of it having to be persisted.
 */
export async function frameQuestion(args: {
	choice: ModelChoice;
	systemPrompt: string;
	message: string;
	history: StoredMessage[];
	compactSummary?: string | null;
	track: (u: Usage | null) => void;
	signal?: AbortSignal;
}): Promise<Framing> {
	const transcript = args.history
		.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${clipExcerpt(m.content, FRAME_TURN_CHARS)}`)
		.join('\n\n');
	const content = [
		`RESEARCH-FRAME: the user has asked for research inside an ongoing conversation.`,
		args.compactSummary ? `--- EARLIER CONVERSATION (summarised) ---\n${args.compactSummary}` : '',
		`--- RECENT CONVERSATION ---\n${transcript}`,
		`--- NEW MESSAGE ---\n${args.message}`,
		`Restate what to research as a question that stands on its own: resolve every "it", "that" and "another round" against the conversation, and name the subject explicitly so someone who has not read any of this could run the search. Do not answer it, and do not broaden it beyond what the new message asks for.`,
		`background: what the conversation already established that the research should build on rather than rediscover — including anything a previous research answer already found. Empty string if there is nothing worth carrying.`,
		`Reply ONLY with JSON: {"question":"…","background":"…"}`
	]
		.filter(Boolean)
		.join('\n\n');

	const ask = (maxTokens: number) =>
		completeIdleBounded(
			args.choice,
			{
				messages: [
					{ role: 'system', content: args.systemPrompt },
					{ role: 'user', content }
				],
				maxTokens
			},
			args.signal
		);

	const asIs = (fellBack: Framing['fellBack']): Framing => ({
		question: args.message,
		background: '',
		fellBack
	});

	try {
		let res = await ask(FRAME_TOKENS);
		args.track(res.usage);
		if (!res.text.trim() && (res.reasonedOnly || res.finishReason === 'length')) {
			res = await ask(FRAME_TOKENS_RETRY);
			args.track(res.usage);
		}
		if (!res.text.trim()) return asIs('empty');
		const start = res.text.indexOf('{');
		const end = res.text.lastIndexOf('}');
		if (start === -1 || end <= start) return asIs('unparseable');
		const parsed = JSON.parse(res.text.slice(start, end + 1)) as {
			question?: unknown;
			background?: unknown;
		};
		const question = typeof parsed.question === 'string' ? parsed.question.trim() : '';
		if (!question) return asIs('unparseable');
		return {
			question,
			background: typeof parsed.background === 'string' ? parsed.background.trim() : '',
			fellBack: null
		};
	} catch {
		return asIs('error');
	}
}

/**
 * A model call that ran out of time rather than failing.
 *
 * Two names for one condition: `TimeoutError` is what an `AbortSignal.timeout`
 * raises, `StreamTimeoutError` is what the idle watchdog raises. Treating only
 * the first as a timeout would have quietly reclassified every stalled call as
 * a generic error the moment these calls started streaming.
 */
function isTimeout(err: unknown): boolean {
	return (
		err instanceof StreamTimeoutError ||
		(err instanceof Error && (err.name === 'TimeoutError' || err.name === 'StreamTimeoutError'))
	);
}

/**
 * `adapter.complete`'s result, obtained by streaming and bounded by silence
 * rather than by total time.
 *
 * The flat deadline this replaces is the same defect synthesis already fixed
 * (see the note on `synthesise`) and the chat and coding loops before it: a
 * model that is working steadily is indistinguishable, to a total deadline,
 * from one that has died. It bit hardest here because these calls are
 * non-streaming, so there was no evidence of progress at all — a reasoning
 * model thinking for over a minute on a 900-token budget was killed having
 * produced nothing, and because a thrown timeout skips the retry branch, the
 * larger allowance that exists for exactly that model never got its turn.
 *
 * The job signal still cancels immediately, and `streamTotalTimeoutMs` remains
 * the backstop against a provider that trickles forever.
 */
async function completeIdleBounded(
	choice: ModelChoice,
	req: { messages: ProviderMessage[]; maxTokens: number },
	signal?: AbortSignal
): Promise<CompletionResult> {
	let text = '';
	let reasoning = '';
	let usage: Usage | null = null;
	let finishReason: string | null = null;
	for await (const ev of streamWithIdleTimeout(
		choice.adapter,
		{ modelKey: choice.model.modelKey, messages: req.messages, maxTokens: req.maxTokens },
		signal ?? new AbortController().signal
	)) {
		if (ev.type === 'text') text += ev.delta;
		else if (ev.type === 'reasoning') reasoning += ev.delta;
		else if (ev.type === 'usage') usage = ev.usage;
		else if (ev.type === 'done') finishReason = ev.finishReason;
	}
	// Same judgement the adapters make on a non-streamed reply: thought, but no
	// answer, is what earns the retry.
	return { text, usage, finishReason, reasonedOnly: !text.trim() && Boolean(reasoning) };
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
		completeIdleBounded(
			choice,
			{
				messages: [
					{ role: 'system', content: systemPrompt },
					{
						role: 'user',
						content: `RESEARCH-PLAN: Produce up to ${maxQueries} focused web-search queries for researching this question. Cover its distinct angles rather than rephrasing it — later rounds will narrow onto whatever these leave open. ${languageBrief(cfg)} Reply ONLY with JSON: {"queries":[{"q":"…","language":"de"}]} — use "" for language when no constraint is wanted.\n\nQuestion: ${question}`
					}
				],
				maxTokens
			},
			opts.signal
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
export function searchAllowance(total: number) {
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

/**
 * Run one round's queries, under the run's pacer, and pool the results.
 *
 * Exported for tests: the throttling behaviour it carries — tighten on the
 * first refusal, say so once — is only observable from here.
 */
export async function runSearches(
	queries: PlannedQuery[],
	searchCfg: WebSearchSettings,
	allowance: ReturnType<typeof searchAllowance>,
	event: (name: string, status: 'ok' | 'error', d: number, detail?: Record<string, unknown>) => void,
	pacer: Pacer,
	/** Called the one time the run tips into throttling, never per query. */
	onThrottled: (pacer: Pacer) => void,
	/**
	 * Called per query with what that query alone returned.
	 *
	 * Before the cross-query dedupe below, deliberately: this is what the reader
	 * sees drawn under the query they can see was run, and silently dropping the
	 * third result of the second query because the first query found it too would
	 * make the boxes disagree with the counts for no stated reason.
	 */
	onResults?: (query: PlannedQuery, results: SearchResult[], status: 'ok' | 'error') => void
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
	const settled = await runPaced(queries.slice(0, granted), pacer, async ({ q, language }) => {
		const started = Date.now();
		try {
			const outcome = await runWebSearch(q, searchCfg, language);
			// Engines that refused are the only signal a search carries about how
			// hard it is being pushed; feed them back before the next claim.
			if (pacer.observe(outcome.degraded?.engines ?? [])) onThrottled(pacer);
			onResults?.({ q, language }, outcome.results, 'ok');
			event('web_search', 'ok', Date.now() - started, {
				query: q,
				results: outcome.results.length,
				provider: outcome.provider,
				searchesUsed: allowance.used,
				searchBudget: allowance.total,
				scope: 'research-run',
				...(pacer.pacing.throttled ? { pacing: 'throttled' } : {}),
				...(language ? { language, languageApplied: outcome.languageApplied !== false } : {}),
				...(outcome.failedOver ? { failedOver: outcome.failedOver } : {})
			});
			return outcome.results;
		} catch (err) {
			if (pacer.observe([String(err)])) onThrottled(pacer);
			// Drawn even so: a query that ran and found nothing is a fact about the
			// round, and an absent box reads as a query that was never tried. Marked
			// as the failure it was, because a search that broke and a search that
			// genuinely found nothing are not the same claim about the world.
			onResults?.({ q, language }, [], 'error');
			event('web_search', 'error', Date.now() - started, {
				query: q,
				error: String(err),
				scope: 'research-run',
				...(pacer.pacing.throttled ? { pacing: 'throttled' } : {}),
				...(language ? { language } : {})
			});
			return [] as SearchResult[];
		}
	});
	const all = settled.flatMap((s) => s ?? []);
	const seen = new Set<string>();
	return all.filter((r) => r.url && !seen.has(r.url) && seen.add(r.url));
}

/**
 * Query parameters that never identify content.
 *
 * Only these are stripped. Dropping a parameter that *does* select content
 * merges two different pages and loses one of them, which is the worse error —
 * hence no `ref`, `source`, `s`, `v` or `id`, each of which is content-bearing
 * somewhere (`youtube.com/watch?v=` being the obvious one).
 */
const TRACKING_PARAM = new Set([
	'gclid', 'dclid', 'fbclid', 'msclkid', 'yclid', 'igshid', 'mc_cid', 'mc_eid',
	'_hsenc', '_hsmi', 'vero_id', 'oly_enc_id', 'ref_src', 'ref_url', 'spm',
	'scm', 'cmpid', 'ncid', 'wt_mc', 'usqp'
]);
const TRACKING_PREFIX = /^(utm_|pk_|piwik_|matomo_|at_(medium|campaign|custom)|hsa_)/i;

/** Paths that are indexes rather than documents. Demoted, never dropped. */
const LOW_VALUE_PATH = /\/(tag|tags|category|categories|author|search|login|signin|register|cart|feed|rss|page)(\/|$)/i;

/**
 * One key for one page.
 *
 * The scheme is dropped entirely, so http and https are the same page — as are
 * `www.example.com` and `example.com`, a trailing slash and none, and every
 * anchor into the same document. Any three of those could otherwise spend three
 * of a round's page slots on one article. Returns '' for anything that is not a
 * fetchable web page, so a `javascript:` result can never reach fetch.
 */
export function canonicalUrlKey(rawUrl: string): string {
	let url: URL;
	try {
		url = new URL(String(rawUrl ?? ''));
	} catch {
		return '';
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
	const host = url.hostname.toLowerCase().replace(/^www\./, '');
	// Path case is preserved: paths are case-sensitive, hosts are not.
	const path = url.pathname.replace(/\/+$/, '');
	const params = [...url.searchParams]
		.filter(([k]) => !TRACKING_PARAM.has(k.toLowerCase()) && !TRACKING_PREFIX.test(k))
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	const query = params.length ? `?${params.map(([k, v]) => `${k}=${v}`).join('&')}` : '';
	return `${host}${path}${query}`;
}

/**
 * eTLD+1, approximated without a public-suffix list.
 *
 * A two-letter TLD with a short second label (`co.uk`, `com.au`, `co.jp`) is
 * treated as a compound suffix. That is wrong for a genuinely short domain
 * under a ccTLD, and it is the right direction to be wrong in: the failure is
 * under-capping one site, not over-capping many.
 */
export function registrableDomain(hostname: string): string {
	const parts = hostname
		.toLowerCase()
		.replace(/^www\./, '')
		.replace(/\.$/, '')
		.split('.');
	if (parts.length <= 2) return parts.join('.');
	const compound = parts.at(-1)!.length === 2 && parts.at(-2)!.length <= 3;
	return parts.slice(compound ? -3 : -2).join('.');
}

export interface TriageOutcome {
	/** What to read, in read order, at most `limit`. */
	picked: SearchResult[];
	/** The deduped, domain-capped survivors — what model triage may choose from. */
	pool: SearchResult[];
	/** Counts only, so the Observatory detail stays flat. */
	dropped: { known: number; duplicate: number; domainCap: number; unusable: number };
}

/**
 * Decide what is worth opening, before anything is fetched.
 *
 * Reading was previously the top N by raw search rank, which let one SEO farm
 * take a round's entire page budget and bought the same article twice whenever
 * a tracking parameter differed. This collapses duplicates, refuses to let one
 * site own a round, and otherwise preserves rank.
 *
 * There is deliberately no quality scoring here: every "is this domain good"
 * heuristic is either an allowlist to maintain or a magic number to defend.
 * Judgement, if wanted, is `triagePages`' job.
 */
export function triageResults(
	results: SearchResult[],
	opts: { limit: number; known?: Iterable<string>; perDomain?: number; poolLimit?: number }
): TriageOutcome {
	const limit = Math.max(0, Math.floor(opts.limit));
	// One site may not take more than a third of a round's slots. At limit 6
	// that is 2; at limit 2 it is 1, which is the right shape at both ends.
	const perDomain = Math.max(1, opts.perDomain ?? Math.ceil(limit / 3));
	const poolLimit = Math.max(limit, opts.poolLimit ?? limit * 4);
	const known = new Set([...(opts.known ?? [])].map(canonicalUrlKey).filter(Boolean));
	const dropped = { known: 0, duplicate: 0, domainCap: 0, unusable: 0 };

	const seen = new Set<string>();
	// Insertion order is first appearance, which is search rank.
	const byDomain = new Map<string, SearchResult[]>();
	for (const r of results) {
		const key = canonicalUrlKey(r?.url ?? '');
		if (!key) {
			dropped.unusable++;
			continue;
		}
		if (known.has(key)) {
			dropped.known++;
			continue;
		}
		if (seen.has(key)) {
			dropped.duplicate++;
			continue;
		}
		seen.add(key);
		const domain = registrableDomain(key.split('/')[0]);
		let bucket = byDomain.get(domain);
		if (!bucket) {
			bucket = [];
			byDomain.set(domain, bucket);
		}
		if (bucket.length >= perDomain) {
			dropped.domainCap++;
			continue;
		}
		bucket.push(r);
	}

	// Round-robin across domains in the order each first appeared: rank survives
	// *within* a site, but one site can no longer take the first four slots.
	const ordered: SearchResult[] = [];
	for (let i = 0; i < perDomain && ordered.length < poolLimit; i++) {
		for (const bucket of byDomain.values()) {
			if (bucket[i]) ordered.push(bucket[i]);
			if (ordered.length >= poolLimit) break;
		}
	}
	// Stable partition, last: an index page still beats nothing.
	const junk = (r: SearchResult) => (LOW_VALUE_PATH.test(pathOf(r.url)) ? 1 : 0);
	const pool = ordered.slice().sort((a, b) => junk(a) - junk(b));
	return { picked: pool.slice(0, limit), pool, dropped };
}

function pathOf(rawUrl: string): string {
	try {
		return new URL(rawUrl).pathname;
	} catch {
		return '';
	}
}

/** Triage is a shortlist judgement, not an essay: keep it cheap and short. */
const TRIAGE_TOKENS = 200;
const TRIAGE_TIMEOUT_MS = 20_000;
const TRIAGE_MAX_CANDIDATES = 24;
const TRIAGE_SNIPPET_CHARS = 200;

/**
 * Which shortlist entries the model wants opened.
 *
 * Ids rather than URLs: a model retyping a URL mangles it, while an integer can
 * be bounds-checked against the pool exactly the way `parseBrief` checks source
 * numbers against the evidence it was given.
 */
export function parseTriagePicks(text: string, poolSize: number, max: number): number[] {
	const start = text.indexOf('{');
	const end = text.lastIndexOf('}');
	if (start === -1 || end <= start) return [];
	let parsed: { open?: unknown };
	try {
		parsed = JSON.parse(text.slice(start, end + 1));
	} catch {
		return [];
	}
	const out: number[] = [];
	const seen = new Set<number>();
	for (const raw of Array.isArray(parsed?.open) ? parsed.open : []) {
		const n = Number(raw);
		if (!Number.isInteger(n) || n < 1 || n > poolSize || seen.has(n)) continue;
		seen.add(n);
		out.push(n);
		if (out.length >= max) break;
	}
	return out;
}

/**
 * Pick which of the shortlist to open and read.
 *
 * Deliberately has **no** reasoning retry, unlike planning and consolidation.
 * Those retry because their fallback is bad — googling the raw question, or
 * losing a round. Here the fallback is a perfectly good deterministic ordering,
 * so a four-thousand-token retry would cost more than the whole step is worth.
 *
 * Returns [] for every failure — throw, abort, empty, unparseable, no valid
 * ids — meaning "no opinion", and the heuristic order stands.
 */
export async function triagePages(args: {
	choice: ModelChoice;
	systemPrompt: string;
	question: string;
	gaps: string[];
	pool: SearchResult[];
	limit: number;
	track: (u: Usage | null) => void;
	signal?: AbortSignal;
}): Promise<SearchResult[]> {
	const pool = args.pool.slice(0, TRIAGE_MAX_CANDIDATES);
	if (pool.length <= args.limit) return [];

	const content = [
		`RESEARCH-TRIAGE: pick up to ${args.limit} of these ${pool.length} search results to open and read in full.`,
		`Prefer primary sources over commentary, pages that plausibly answer an open gap, and different publishers over several tellings of the same story. Skip listings, aggregators, and pages whose title and snippet promise only what the brief already has.`,
		`Question: ${args.question}`,
		args.gaps.length ? `Open gaps:\n${args.gaps.map((g) => `- ${g}`).join('\n')}` : '',
		`Candidates:\n${pool
			.map(
				(r, i) =>
					`${i + 1}. ${r.title || r.url} — ${r.url}\n   ${clipExcerpt(r.snippet ?? '', TRIAGE_SNIPPET_CHARS)}`
			)
			.join('\n')}`,
		`Reply ONLY with JSON: {"open":[3,1,7]} — ids in the order you would read them.`
	]
		.filter(Boolean)
		.join('\n\n');

	try {
		const res = await args.choice.adapter.complete(
			{
				modelKey: args.choice.model.modelKey,
				messages: [
					{ role: 'system', content: args.systemPrompt },
					{ role: 'user', content }
				],
				maxTokens: TRIAGE_TOKENS
			},
			args.signal
				? AbortSignal.any([args.signal, AbortSignal.timeout(TRIAGE_TIMEOUT_MS)])
				: AbortSignal.timeout(TRIAGE_TIMEOUT_MS)
		);
		args.track(res.usage);
		return parseTriagePicks(res.text ?? '', pool.length, args.limit).map((n) => pool[n - 1]);
	} catch {
		return [];
	}
}

export interface ReadPagesDeps {
	/**
	 * Model triage, when the round earned one. Never throws; an empty result
	 * means "no opinion — keep the heuristic order".
	 */
	chooser?: (pool: SearchResult[], limit: number) => Promise<SearchResult[]>;
	/** Injected in tests so no suite depends on the network. */
	readPage?: (url: string, timeoutMs: number) => Promise<string>;
	/**
	 * The shape of the round's funnel, once it is settled.
	 *
	 * These numbers were computed and emitted to the Observatory already, but
	 * nowhere a reader would look. They are the answer to "why did it only read
	 * six of the eighty things it found", which is otherwise invisible.
	 */
	onTriage?: (funnel: { candidates: number; pool: number; opened: number }) => void;
}

export async function readPages(
	results: SearchResult[],
	existing: Evidence[],
	limit: number,
	timeoutMs: number,
	event: (name: string, status: 'ok' | 'error', d: number, detail?: Record<string, unknown>) => void,
	deps: ReadPagesDeps = {}
): Promise<Evidence[]> {
	const triage = triageResults(results, { limit, known: existing.map((e) => e.url) });
	event('research.triage', 'ok', 0, {
		candidates: results.length,
		pool: triage.pool.length,
		picked: triage.picked.length,
		domains: new Set(triage.pool.map((r) => registrableDomain(canonicalUrlKey(r.url).split('/')[0])))
			.size,
		...triage.dropped
	});

	let toRead = triage.picked;
	// Only worth asking when there is a real choice to make.
	if (deps.chooser && triage.pool.length >= limit * 3) {
		const startedAt = Date.now();
		const chosen = await deps.chooser(triage.pool, limit);
		event('research.triage.model', chosen.length ? 'ok' : 'error', Date.now() - startedAt, {
			pool: triage.pool.length,
			...(chosen.length ? { picked: chosen.map((r) => r.url) } : { fellBack: 'heuristic order' })
		});
		if (chosen.length) toRead = chosen;
	}
	// After the chooser, so `opened` is what is actually about to be read.
	deps.onTriage?.({
		candidates: results.length,
		pool: triage.pool.length,
		opened: toRead.length
	});

	const readPage = deps.readPage ?? fetchPageText;
	let n = existing.length;
	const settled = await Promise.allSettled(
		toRead.map(async (r): Promise<Omit<Evidence, 'n'> | null> => {
			const started = Date.now();
			let retried = false;
			const base = { title: r.title || r.url, url: r.url };
			const attempt = async () => {
				const excerpt = (await readPage(r.url, timeoutMs)).trim();
				// A 200 that extracts to nothing is not a read page — it is a JS
				// shell or a paywall — and passing it on as an empty excerpt gave
				// synthesis a citable URL with nothing behind it.
				if (!excerpt) throw new PageFetchError('no-text', 'No readable text on the page');
				return excerpt;
			};
			try {
				let excerpt: string;
				try {
					excerpt = await attempt();
				} catch (err) {
					// One more go, and only for the classes worth it. Every other
					// flaky dependency here already fails over; the one talking to
					// the open web had nothing.
					if (!isRetryableFetch(err)) throw err;
					await new Promise((r2) => setTimeout(r2, RETRY_BACKOFF_MS));
					excerpt = await attempt();
					retried = true;
				}
				event('fetch_page', 'ok', Date.now() - started, {
					url: r.url,
					chars: excerpt.length,
					...(retried ? { retried: true } : {})
				});
				return { ...base, excerpt, kind: 'page' as const };
			} catch (err) {
				const { reason, detail } = classifyFetchError(err);
				event('fetch_page', 'error', Date.now() - started, {
					url: r.url,
					reason,
					error: detail,
					...(err instanceof PageFetchError && err.status ? { status: err.status } : {}),
					...(retried ? { retried: true } : {})
				});
				const snippet = (r.snippet ?? '').trim();
				// Neither page nor snippet is a source in name only.
				return snippet ? { ...base, excerpt: snippet, kind: 'snippet' as const, failure: reason } : null;
			}
		})
	);
	return settled
		.filter(
			(s): s is PromiseFulfilledResult<Omit<Evidence, 'n'> | null> => s.status === 'fulfilled'
		)
		.map((s) => s.value)
		.filter((v): v is Omit<Evidence, 'n'> => v !== null)
		.map((v) => ({ ...v, n: ++n }));
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
	/** What the user actually typed, verbatim. The run stays answerable to it. */
	asked: string;
	/** The framed standalone question — what is being searched. */
	question: string;
	/** What the conversation already established, from framing. */
	background?: string;
	prior: ResearchBrief;
	/** Only this round's new sources — full excerpts. */
	fresh: Evidence[];
	/** Every source so far, rendered compactly so carried citations stay checkable. */
	allEvidence: Evidence[];
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
		`--- WHAT WAS ASKED ---`,
		args.asked,
		...(args.question.trim() && args.question.trim() !== args.asked.trim()
			? [`--- RESEARCHING ---`, args.question]
			: []),
		...(args.background ? [`--- FROM THE CONVERSATION ---`, args.background] : []),
		`--- BRIEF SO FAR ---`,
		briefToPrompt(prior),
		`--- SOURCES SO FAR ---`,
		sourceRegister(args.allEvidence),
		`--- NEW SOURCES THIS ROUND ---`,
		evidenceToPrompt(fresh, perSource),
		[
			`Update the brief from what these sources actually say, not from what you already believe. Keep it answerable to WHAT WAS ASKED, not only to the restated question.`,
			`findings: the COMPLETE brief as it now stands — every earlier finding that still holds, restated, plus whatever these sources add. Anything you leave out is treated as withdrawn, so drop a finding only when you mean to retract it, and correct one by restating it corrected. Each finding carries the source numbers supporting it, and they must come from the register above.`,
			`Use the register to check a carried finding before restating it: if the sources it cites do not actually support it, correct it or turn it into a gap.`,
			`A source marked SEARCH SNIPPET ONLY is a search engine's summary, not the page. Use it to establish that something exists and to aim the next search — do not rest a finding on it, and if it is the only support for a claim, write that claim as a gap instead.`,
			`gaps: what the question still needs and no source has answered. Write each one specifically enough that a web search can be made of it as it stands.`,
			`conflicts: where sources disagree, naming both numbers.`,
			`sufficient: true only when the remaining gaps could not change the answer.`,
			`next_queries: up to ${args.maxQueries} searches that would close the biggest gaps. Do not repeat these, which have already been run: ${args.ranQueries.map((q) => `"${q}"`).join(', ')}. ${languageBrief(cfg)}`,
			`Reply ONLY with JSON: {"findings":[{"claim":"…","sources":[1,4]}],"gaps":["…"],"conflicts":["…"],"sufficient":false,"next_queries":[{"q":"…","language":"de"}]}`
		].join(' ')
	].join('\n\n');

	const ask = (maxTokens: number) =>
		completeIdleBounded(
			choice,
			{
				// The old review call sent no system prompt at all, unlike planning
				// and synthesis — part of why its judgement was poor.
				messages: [
					{ role: 'system', content: args.systemPrompt },
					{ role: 'user', content }
				],
				maxTokens
			},
			args.signal
		);

	let res;
	try {
		try {
			res = await ask(CONSOLIDATE_TOKENS);
			track(res.usage);
		} catch (err) {
			// A first attempt that ran out of time is the *same* failure the retry
			// below exists for — a model still thinking when its allowance ran out —
			// and it used to be the one form of it that never got a second chance,
			// because a throw skips the retry branch entirely. Give it the larger
			// budget, which is what lets it finish thinking and still answer.
			if (args.signal?.aborted || !isTimeout(err)) throw err;
			res = await ask(CONSOLIDATE_TOKENS_RETRY);
			track(res.usage);
		}
		// Same reasoning-model allowance the planner makes: a model that spent the
		// first budget thinking gets one retry with real headroom.
		if (!res.text.trim() && (res.reasonedOnly || res.finishReason === 'length')) {
			res = await ask(CONSOLIDATE_TOKENS_RETRY);
			track(res.usage);
		}
	} catch (err) {
		if (args.signal?.aborted) return { status: 'cancelled' };
		if (isTimeout(err)) return { status: 'timeout' };
		return { status: 'error', error: String(err) };
	}

	if (!res.text.trim()) return { status: 'empty', reasonedOnly: Boolean(res.reasonedOnly) };
	const parsed = parseBrief(res.text, {
		knownSources: args.allEvidence.map((e) => e.n),
		readSources: args.allEvidence.filter((e) => e.kind === 'page').map((e) => e.n),
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
	opts: {
		knownSources: number[];
		/** Which of those were read in full, so a finding's support can be judged. */
		readSources?: Iterable<number>;
		maxQueries: number;
		fallbackLanguage?: string;
	}
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
	const read = new Set(opts.readSources ?? opts.knownSources);
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
		const unique = [...new Set(sources)];
		// A claim is only as good as its best source: read if any backing source
		// was read in full, snippet-only otherwise.
		const support = unique.some((n) => read.has(n)) ? 'read' : 'snippet';
		findings.push({ claim, sources: unique, support });
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
	return {
		round,
		// The round owns the brief: it is shown the whole prior one and the source
		// register, and is told that anything it omits counts as withdrawn — so an
		// omission is a decision, not an accident.
		//
		// Merging instead used to make three separate messes. Findings were
		// deduplicated on exact text, so a reworded restatement was a new finding
		// and a *correction* sat alongside the claim it corrected. The cap then
		// evicted from the tail, which was always the oldest surviving findings —
		// so a round that restated a dozen things in fresh words silently deleted
		// round one while appearing to preserve it.
		//
		// The one thing worth guarding is a round that returns nothing at all:
		// that is a formatting slip, not a retraction of everything.
		findings: next.findings.length ? next.findings.slice(0, MAX_FINDINGS) : prev.findings,
		// Same reasoning for gaps — a shorter list is progress, an empty one from a
		// round that also said "not sufficient" is a slip.
		gaps: next.gaps.length || next.sufficient ? next.gaps : prev.gaps,
		// Conflicts accumulate: two sources disagreeing stays true whether or not
		// a later round happens to mention it again.
		conflicts: mergeConflicts(prev.conflicts, next.conflicts),
		sufficient: next.sufficient
	};
}

function mergeConflicts(prev: string[], next: string[]): string[] {
	const key = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
	const out: string[] = [];
	const seen = new Set<string>();
	for (const c of [...next, ...prev]) {
		const k = key(c);
		if (!k || seen.has(k)) continue;
		seen.add(k);
		out.push(c);
		if (out.length >= MAX_CONFLICTS) break;
	}
	return out;
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
/**
 * Content types worth extracting text from.
 *
 * Shared with the `fetch_url` tool, which had its own copy while research had
 * no check at all — which is how a PDF or a JPEG became binary noise handed to
 * synthesis as a source.
 */
export const READABLE_TYPE =
	/^(text\/|application\/(json|xml|xhtml\+xml|javascript|x-yaml|yaml)|.*\+(json|xml)$)/i;

/**
 * Hard byte ceiling on a research download, independent of the character cap
 * on the output: the clip happens after the body is in memory, so without this
 * one link to a large file is pulled in full first.
 */
export const MAX_PAGE_BYTES = 2_000_000;

/** Read a response body up to a byte ceiling, then stop pulling. */
async function readCappedBytes(res: Response, maxBytes: number): Promise<Buffer> {
	const reader = res.body?.getReader();
	if (!reader) return Buffer.from(await res.arrayBuffer());
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value) {
			chunks.push(value);
			total += value.length;
		}
		if (total >= maxBytes) {
			await reader.cancel().catch(() => {});
			break;
		}
	}
	return Buffer.concat(chunks);
}

/**
 * Decode a page body using the encoding it was actually served in.
 *
 * Everything used to be read as UTF-8. A UTF-16 page then decoded to a string
 * full of real NUL characters and was rejected outright by the binary sniff
 * below — a guaranteed snippet-only source, reported as "binary content". A
 * Latin-1 or CP1252 page fared worse in its way: every accent, curly quote and
 * dash became U+FFFD and the mangled text was passed on with nothing reporting
 * it. The header wins; a `<meta charset>` is the fallback; UTF-8 is the default.
 */
export function decodeBody(bytes: Buffer, contentType: string): string {
	const declared = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
	// The meta tag is ASCII-compatible in every encoding that matters here, so a
	// provisional Latin-1 read is enough to find it.
	const sniffed = declared
		? null
		: /<meta[^>]+charset=["']?([\w-]+)/i.exec(bytes.subarray(0, 4096).toString('latin1'))?.[1];
	const bom =
		bytes[0] === 0xff && bytes[1] === 0xfe
			? 'utf-16le'
			: bytes[0] === 0xfe && bytes[1] === 0xff
				? 'utf-16be'
				: null;
	for (const label of [bom, declared, sniffed, 'utf-8']) {
		if (!label) continue;
		try {
			return new TextDecoder(label, { fatal: false }).decode(bytes);
		} catch {
			// An encoding name Node does not know; fall through to the next.
		}
	}
	return bytes.toString('utf8');
}

/**
 * Why a page could not be read.
 *
 * Every cause used to reach both the model and the reader as the same seven
 * words — "page could not be read" — so "Facebook refused our bot", "the page
 * was UTF-16" and "we timed out" were indistinguishable, and nobody could tell
 * whether a thin answer meant the web refused us or the material was not there.
 */
export type FetchFailure =
	| 'blocked'
	| 'unavailable'
	| 'timeout'
	| 'unreadable-type'
	| 'no-text'
	| 'network';

/** How a failure reads in a prompt and in the sources list. */
export const FETCH_FAILURE_TEXT: Record<FetchFailure, string> = {
	blocked: 'the site refused the request',
	unavailable: 'the site was unavailable',
	timeout: 'the request timed out',
	'unreadable-type': 'the address is not a readable document',
	'no-text': 'the page carried no readable text',
	network: 'the address could not be reached'
};

export class PageFetchError extends Error {
	readonly reason: FetchFailure;
	readonly status?: number;
	constructor(reason: FetchFailure, message: string, status?: number) {
		super(message);
		this.name = 'PageFetchError';
		this.reason = reason;
		this.status = status;
	}
}

/**
 * Classify whatever a fetch threw.
 *
 * undici buries the real cause in `err.cause` and `String(err)` does not
 * include it, which is why every network failure used to read
 * `TypeError: fetch failed` in the Observatory.
 */
export function classifyFetchError(err: unknown): { reason: FetchFailure; detail: string } {
	if (err instanceof PageFetchError) {
		return { reason: err.reason, detail: err.message };
	}
	if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
		return { reason: 'timeout', detail: err.message || 'timed out' };
	}
	const cause = err instanceof Error && err.cause ? ` (${String(err.cause)})` : '';
	return { reason: 'network', detail: `${String(err)}${cause}` };
}

/**
 * Worth one more attempt: the same classes the model loop already fails over
 * on, plus the HTTP statuses that mean "ask again shortly".
 */
export function isRetryableFetch(err: unknown): boolean {
	if (err instanceof PageFetchError) {
		return err.reason === 'timeout' || err.reason === 'unavailable' || err.status === 429;
	}
	return isRetryable(err);
}

/** Pause before the single retry, so a rate limit has a moment to clear. */
const RETRY_BACKOFF_MS = 700;

/** Redirect hops one fetch may follow before giving up. */
const MAX_REDIRECTS = 5;

/**
 * Fetch a URL with the SSRF guard re-checked on every hop.
 *
 * `assertPublicHttpUrl` was pre-flight only, while `redirect: 'follow'` let
 * undici chase the chain unsupervised — so a search result whose server
 * answered `302 Location: http://169.254.169.254/` was fetched from the
 * internal address with the guard never running again. Following the chain by
 * hand is the only way to see each hop.
 *
 * Shared with the `fetch_url` tool, which had the identical hole.
 */
export async function safeFetch(
	url: string,
	init: RequestInit & { signal?: AbortSignal },
	fetchImpl: typeof fetch = fetch
): Promise<Response> {
	let target = url;
	for (let hop = 0; ; hop++) {
		assertPublicHttpUrl(target);
		const res = await fetchImpl(target, { ...init, redirect: 'manual' });
		const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
		if (!location) return res;
		if (hop >= MAX_REDIRECTS) throw new Error(`Too many redirects (${MAX_REDIRECTS})`);
		// Relative Locations are legal and common.
		target = new URL(location, target).href;
	}
}

export interface PageFetchDeps {
	/** Injected in tests so no suite depends on the network. */
	fetchImpl?: typeof fetch;
}

export async function fetchPageText(
	url: string,
	timeoutMs: number,
	deps: PageFetchDeps = {}
): Promise<string> {
	// safeFetch asserts the guard on this URL and on every redirect hop.
	const res = await safeFetch(
		url,
		{
			signal: AbortSignal.timeout(timeoutMs),
			headers: {
				// The same UA the search engines are given one step earlier. A
				// bot-shaped UA is the single biggest reason a page comes back as a
				// search snippet instead of an article.
				'user-agent': BROWSER_UA,
				// Was `text/html,text/plain`, which some servers honour by 406-ing a
				// perfectly readable page.
				accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
				// Several CDNs score its absence on its own.
				'accept-language': 'en-GB,en;q=0.9'
			}
		},
		deps.fetchImpl
	);
	if (!res.ok) {
		throw new PageFetchError(
			res.status >= 500 ? 'unavailable' : 'blocked',
			`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`,
			res.status
		);
	}

	const contentType = res.headers.get('content-type') ?? '';
	const bare = contentType.split(';')[0].trim().toLowerCase();

	// A PDF is a source, not a refusal: the extractor already exists for
	// attachments and a lot of primary material is only published this way.
	if (bare === 'application/pdf') {
		const { extractPdf } = await import('$lib/server/attachments');
		return clipPage(await extractPdf(await readCappedBytes(res, MAX_PAGE_BYTES)));
	}
	if (bare && !READABLE_TYPE.test(bare)) {
		throw new PageFetchError('unreadable-type', `Not readable as text: ${bare}`);
	}

	const body = decodeBody(await readCappedBytes(res, MAX_PAGE_BYTES), contentType);
	// Sniffed regardless of what the server claimed: a missing content-type and
	// a PDF mislabelled `text/plain` both end the same way otherwise, with
	// binary noise handed to synthesis as a source. Cheap, first kilobyte only,
	// and no real page opens with %PDF- or carries NUL bytes.
	if (/^%PDF-|\u0000/.test(body.slice(0, 1024))) {
		throw new PageFetchError('unreadable-type', 'Not readable as text: binary content');
	}
	// text/plain must not go through the HTML stripper, which mangles code and
	// comparison operators.
	const html = bare ? /html|xml/.test(bare) : /^\s*(<!doctype html|<html|<)/i.test(body);
	return clipPage(html ? htmlToReadableText(body) : body.trim());
}

const ENTITIES: Record<string, string> = {
	nbsp: ' ',
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	rsquo: '\u2019',
	lsquo: '\u2018',
	rdquo: '\u201d',
	ldquo: '\u201c',
	mdash: '\u2014',
	ndash: '\u2013',
	hellip: '\u2026'
};

/**
 * Decode entities in one pass.
 *
 * Sequential per-entity replaces double-decode — `&amp;lt;` became `<` rather
 * than the literal `&lt;` the page meant — and numeric entities, which real
 * articles are full of (`&#8217;` for a curly apostrophe), passed straight
 * through as garbage.
 */
function decodeEntities(text: string): string {
	return text.replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z]+);/gi, (whole, body: string) => {
		if (body[0] === '#') {
			const code =
				body[1] === 'x' || body[1] === 'X'
					? Number.parseInt(body.slice(2), 16)
					: Number(body.slice(1));
			return Number.isFinite(code) && code > 0 && code <= 0x10ffff
				? String.fromCodePoint(code)
				: whole;
		}
		return ENTITIES[body.toLowerCase()] ?? whole;
	});
}

/**
 * Tags to text.
 *
 * Contract deliberately unchanged: the `fetch_url` tool applies this to pages
 * the user asked for by name (tools/fetch-url.ts), where the navigation is
 * part of what was asked for. Research wants something more aggressive and
 * gets it from `htmlToReadableText` below.
 */
export function htmlToText(html: string): string {
	return decodeEntities(
		html
			.replace(/<script[\s\S]*?<\/script>/gi, ' ')
			.replace(/<style[\s\S]*?<\/style>/gi, ' ')
			.replace(/<!--[\s\S]*?-->/g, ' ')
			.replace(/<br\s*\/?>/gi, '\n')
			.replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
			.replace(/<[^>]+>/g, ' ')
	)
		.replace(/[ \t]+/g, ' ')
		.replace(/\n\s*\n\s*/g, '\n\n')
		.trim();
}

/**
 * Elements whose contents are never prose.
 *
 * Removed before anything else, and that ordering is load-bearing: a `<script>`
 * body can contain the literal text `</main>` or `<nav>` inside a JS string, so
 * leaving scripts in place lets a site's own JavaScript steer every decision
 * below it.
 */
const OPAQUE = 'script|style|noscript|template|svg|math|iframe|canvas|object|embed|video|audio|select|textarea|button';

/** Furniture, removed inside the content subtree as well as outside it. */
const CHROME = 'nav|aside|form|dialog|menu';

/**
 * Furniture only when the page named no content subtree. Inside an `<article>`,
 * `<header>` is the headline and byline and `<footer>` is the dateline.
 */
const OUTER_CHROME = 'header|footer';

/** Largest region one strip may remove; bounds the unclosed-tag hazard. */
const MAX_STRIP_CHARS = 20_000;
/** A subtree holding less than this is a shell, not the article. */
const SUBTREE_MIN_CHARS = 200;
/** Below this, assume the strip went wrong and check against the raw page. */
const READABLE_MIN_CHARS = 400;

const roughTextLength = (fragment: string) =>
	fragment
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim().length;

/**
 * Remove whole elements by tag name.
 *
 * Non-greedy, always. The greedy form runs from the page's first `<nav>` to its
 * last `</nav>` and takes the article sitting between them, which on a page
 * with a top nav and a footer nav is the entire document.
 *
 * Even lazily, an *unclosed* tag matches forward to whatever close tag comes
 * next, which may be past the article — so a match far larger than any real
 * nav is treated as evidence of broken markup and left alone, to become noisy
 * text rather than a deleted article. Nesting degrades the same safe way: the
 * inner element goes and the outer wrapper leaks through as text.
 *
 * Class and id heuristics on `<div>` are deliberately not attempted. `<div>`
 * nests arbitrarily and a regex cannot balance it: any rule either stops at the
 * first inner `</div>`, leaving a mess, or runs to the last and eats the page.
 * That is the one readability trick that genuinely needs a parser.
 */
function stripElements(html: string, tags: string): string {
	const re = new RegExp(`<(${tags})\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>`, 'gi');
	return html.replace(re, (match) => (match.length <= MAX_STRIP_CHARS ? ' ' : match));
}

/** The page's own claim about where its content lives. */
function contentSubtree(doc: string): string | null {
	const main = doc.match(/<main\b[^>]*>([\s\S]*?)<\/main\s*>/i);
	const candidate =
		main?.[1] ??
		[...doc.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article\s*>/gi)].map((m) => m[1]).join('\n');
	// An empty <main> is an SPA shell whose content is rendered elsewhere in the
	// document; taking it would hand back nothing at all.
	return roughTextLength(candidate) >= SUBTREE_MIN_CHARS ? candidate : null;
}

/**
 * Narrow a page to the part that is actually prose. HTML in, HTML out — kept
 * separate from the text conversion so a test can assert what survived the
 * strip rather than only what the text looks like afterwards.
 */
export function extractReadableHtml(html: string): string {
	let doc = html.replace(/<!--[\s\S]*?-->/g, ' ');
	doc = stripElements(doc, OPAQUE);
	// <head> is metadata; its <title> would otherwise open every excerpt.
	doc = doc.replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/i, ' ');
	const body = doc.match(/<body\b[^>]*>([\s\S]*)<\/body\s*>/i);
	if (body) doc = body[1];

	const subtree = contentSubtree(doc);
	return subtree ? stripElements(subtree, CHROME) : stripElements(doc, `${CHROME}|${OUTER_CHROME}`);
}

/**
 * Article text out of a page's JSON-LD.
 *
 * Scripts are stripped before anything else, which is right — a `<script>` body
 * can contain the literal text `</main>` and steer the subtree choice — but it
 * also throws away the one machine-readable copy of the article that many news
 * and product pages carry. When the ordinary extraction comes back empty, this
 * is often the difference between a source and a search snippet.
 *
 * Only `application/ld+json` is mined. Framework payloads (`__NEXT_DATA__`,
 * `ytInitialData`) would need per-site knowledge and are deliberately left.
 */
export function jsonLdText(html: string): string {
	const blocks = [
		...html.matchAll(
			/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi
		)
	];
	const found: string[] = [];
	const visit = (node: unknown, depth = 0) => {
		if (depth > 6 || found.length >= 4) return;
		if (Array.isArray(node)) {
			for (const item of node) visit(item, depth + 1);
			return;
		}
		if (!node || typeof node !== 'object') return;
		const record = node as Record<string, unknown>;
		for (const key of ['articleBody', 'text', 'description', 'reviewBody']) {
			const value = record[key];
			if (typeof value === 'string' && value.trim().length > 80) found.push(value.trim());
		}
		for (const value of Object.values(record)) {
			if (value && typeof value === 'object') visit(value, depth + 1);
		}
	};
	for (const block of blocks) {
		try {
			visit(JSON.parse(block[1].trim()));
		} catch {
			// A malformed block is not worth failing the page over.
		}
	}
	// Longest first: articleBody beats a one-line description.
	return found
		.sort((a, b) => b.length - a.length)
		.slice(0, 2)
		.join('\n\n');
}

/**
 * A page reduced to its readable text, with a net under it.
 *
 * If stripping left almost nothing and the plain conversion is much longer,
 * the strip went wrong — so the worst case is today's behaviour rather than an
 * empty excerpt. Deliberately not a "did we remove too much" ratio check: a
 * page that is 80% boilerplate is exactly the case being fixed here.
 */
export function htmlToReadableText(html: string): string {
	const readable = htmlToText(extractReadableHtml(html));
	if (readable.length >= READABLE_MIN_CHARS) return readable;
	// The page's own structured copy of itself, when the markup gave us nothing.
	const structured = decodeEntities(jsonLdText(html));
	if (structured.length > readable.length) return structured;
	const plain = htmlToText(html);
	return plain.length > readable.length * 3 ? plain : readable;
}

/** Clip to the budget, preferring a paragraph boundary near the end of it. */
export function clipPage(text: string): string {
	if (text.length <= PAGE_TEXT_CHARS) return text;
	const head = text.slice(0, PAGE_TEXT_CHARS);
	const cut = head.lastIndexOf('\n\n');
	// Never give back more than 40% of the budget chasing a boundary.
	return (cut > PAGE_TEXT_CHARS * 0.6 ? head.slice(0, cut) : head).trimEnd();
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
