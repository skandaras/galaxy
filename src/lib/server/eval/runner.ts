import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, asc, desc, eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { chats, messages, type EvidenceItem } from '$lib/server/db/schema';
import { appendMessage, createChat, getChat, getMessages, updateChat } from '$lib/server/chats';
import { buildContext } from '$lib/server/engine/context';
import { chatModels, pickModel, prepareChatTurn, type TurnOverrides } from '$lib/server/engine/engine';
import { createJob } from '$lib/server/engine/jobs';
import { chatMaxSteps } from '$lib/server/engine/limits';
import { runAgentLoop, withBudgetNote, type LoopTool } from '$lib/server/engine/loop';
import { costOf } from '$lib/server/engine/usage';
import { requestBody } from '$lib/server/providers/openai-compatible';
import { reasoningFor, type ModelChoice } from '$lib/server/providers/registry';
import type { ChatRequest, ReasoningEffort } from '$lib/server/providers/types';
import { languageSettings } from '$lib/server/settings';
import { SHORT_LANGUAGE } from './language-short';

/**
 * A small harness for comparing chat replies on the owner's own conversations.
 *
 * The conversation-quality review asked for one before any default changes:
 * replay a handful of real cases through the same assembly production uses
 * (prepareChatTurn), vary one thing at a time, and put the replies in front of
 * the owner blind. Software tests say the request is built correctly; only the
 * owner can say whether a reply is better. See docs/EVAL.md for how to run it.
 */

export interface EvalCase {
	id: string;
	/** Turns before the prompt. An assistant turn may carry the evidence its tools read. */
	history?: { role: 'user' | 'assistant'; content: string; evidence?: EvidenceItem[] }[];
	/** Lift the history from a chat in the scratch database instead. */
	fromChat?: string;
	prompt: string;
	/** What a good reply does, for whoever scores it. Never shown to the model. */
	expect?: string;
	/**
	 * Fixed tool results, by tool name: one string for every call, or a list of
	 * `{ match, output }` where `match` holds argument values the call must have.
	 */
	toolFixtures?: Record<string, string | { match?: Record<string, unknown>; output: string }[]>;
	webSearch?: boolean;
}

export interface Variant {
	name: string;
	overrides: TurnOverrides;
	modelId?: string;
}

/**
 * A variant from its name. Each changes one thing against the instance's own
 * configuration, so a difference in the replies has one cause.
 */
export function parseVariant(spec: string, opts: { pin?: string } = {}): Variant {
	const [kind, arg] = spec.split(':');
	switch (kind) {
		case 'baseline':
			return { name: 'baseline', overrides: {} };
		case 'short-language':
			return { name: 'short-language', overrides: { language: SHORT_LANGUAGE } };
		case 'effort': {
			const effort = (arg ?? 'medium') as ReasoningEffort;
			if (!['low', 'medium', 'high'].includes(effort)) throw new Error(`effort must be low, medium or high, not ${arg}`);
			return { name: `effort-${effort}`, overrides: { reasoning: effort } };
		}
		case 'lean':
			return { name: 'lean', overrides: { lean: true } };
		case 'no-evidence':
			return { name: 'no-evidence', overrides: { evidence: false } };
		case 'pinned': {
			const slug = arg ?? opts.pin;
			if (!slug) throw new Error('pinned needs a provider, as pinned:<slug> or --pin <slug>');
			return {
				name: `pinned-${slug}`,
				overrides: { provider: { order: [slug], allow_fallbacks: false, require_parameters: true } }
			};
		}
		case 'model':
			if (!arg) throw new Error('model needs a model id, as model:<id>');
			return { name: `model-${arg.slice(0, 12)}`, overrides: {}, modelId: arg };
		default:
			throw new Error(`Unknown variant ${spec}. Try baseline, short-language, effort:medium, lean, no-evidence, pinned:<slug>, model:<id>.`);
	}
}

export interface RunContext {
	userId: string;
	maxUsd: number;
	/** What the run has spent so far, shared by every case. */
	spent: { usd: number; unpriced: number };
	liveTools: boolean;
	/** A model for every variant, unless the variant names its own. */
	modelId?: string;
	/** Injected in tests; otherwise the instance's own chat models. */
	models?: (modelId?: string) => { choice: ModelChoice | null; backup: ModelChoice | null };
}

export interface CaseResult {
	caseId: string;
	variant: string;
	prompt: string;
	expect: string;
	reply: string;
	model: string;
	ttftMs: number | null;
	totalMs: number;
	calls: number;
	promptTokens: number;
	completionTokens: number;
	reasoningTokens: number;
	/** Null when any call had no price, rather than a total that leaves it out. */
	costUsd: number | null;
	failover: boolean;
	effortSent: string;
	bannedHits: number;
	error: string | null;
}

class SpendCapReached extends Error {}

interface Meter {
	started: number;
	ttft: number | null;
	calls: number;
	promptTokens: number;
	completionTokens: number;
	reasoningTokens: number;
	cost: number;
	unpriced: boolean;
	effort: string;
}

/**
 * The model's adapter with a meter and the spend cap in front of it. The cap is
 * checked before each call, so a call already in flight can still take the run
 * past it; the summary says what was actually spent.
 */
function metered(choice: ModelChoice, m: Meter, ctx: RunContext): ModelChoice {
	const inner = choice.adapter;
	const guard = () => {
		if (ctx.spent.usd >= ctx.maxUsd) {
			throw new SpendCapReached(`Spend cap of $${ctx.maxUsd} reached; nothing more is called.`);
		}
	};
	const unpriced = () => {
		m.unpriced = true;
		ctx.spent.unpriced++;
	};
	const count = (usage: { promptTokens: number; completionTokens: number; reasoningTokens?: number }) => {
		m.promptTokens += usage.promptTokens;
		m.completionTokens += usage.completionTokens;
		m.reasoningTokens += usage.reasoningTokens ?? 0;
		const cost = costOf(choice.model, usage);
		if (cost === null) {
			unpriced();
		} else {
			m.cost += cost;
			ctx.spent.usd += cost;
		}
	};
	return {
		...choice,
		adapter: {
			...inner,
			async *stream(req, signal) {
				guard();
				m.calls++;
				m.effort = req.reasoning ?? 'not sent';
				let reported = false;
				try {
					for await (const ev of inner.stream(req, signal)) {
						if (ev.type === 'text' && m.ttft === null) m.ttft = Date.now() - m.started;
						if (ev.type === 'usage') {
							reported = true;
							count(ev.usage);
						}
						yield ev;
					}
				} finally {
					// A call that said nothing about its usage, or died first, has an
					// unknown price, which is not the same as a price of nothing.
					if (!reported) unpriced();
				}
			},
			async complete(req, signal) {
				guard();
				m.calls++;
				const res = await inner.complete(req, signal).catch((err) => {
					unpriced();
					throw err;
				});
				if (res.usage) count(res.usage);
				else unpriced();
				return res;
			}
		}
	};
}

/**
 * The tools with their results fixed by the case, so a comparison of replies
 * is not also a comparison of what the web said that minute. A call the case
 * did not plan for fails, loudly, rather than quietly reaching the live tool.
 */
function frozen(tools: LoopTool[], c: EvalCase, only?: Set<string>): LoopTool[] {
	return tools.map((tool) => (only && !only.has(tool.def.name) ? tool : {
		...tool,
		execute: async (args: Record<string, unknown>) => {
			const fixture = c.toolFixtures?.[tool.def.name];
			if (typeof fixture === 'string') return fixture;
			const hit = fixture?.find((f) =>
				Object.entries(f.match ?? {}).every(([k, v]) => String(args[k] ?? '') === String(v))
			);
			if (hit) return hit.output;
			throw new Error(
				`No fixture for ${tool.def.name}(${JSON.stringify(args).slice(0, 200)}) in case ${c.id}. Add one under toolFixtures${only ? '' : ', or run with --live-tools'}.`
			);
		}
	}));
}

/**
 * Tools that stay on fixtures even with --live-tools. ask_user waits for a
 * browser that is not there, so a case would never finish; the image tools
 * call a model of their own, outside the meter, so their spend would pass the
 * cap unseen.
 */
const NEVER_LIVE = new Set(['ask_user', 'generate_image', 'view_image']);

/**
 * A fresh chat for one case and one variant, with the case's history in it.
 * A case lifted from a real chat with no prompt of its own replays that chat's
 * last question, against everything said before it.
 */
function seedChat(c: EvalCase, v: Variant, ctx: RunContext) {
	const source = c.fromChat ? getChat(c.fromChat, ctx.userId) : null;
	// The things about a chat that change what is sent: a hand-off's supplement
	// prompt, and whether the chat still needs naming, which adds a note and a
	// tool to a first turn. Copied from a lifted chat, and left as a new chat has
	// them otherwise, so the replay sends what production would.
	const chat = createChat({ userId: ctx.userId, agentTask: source?.agentTask ?? null });
	// A label, set the way the auto-titler sets one, so it does not count as a
	// name somebody chose.
	updateChat(chat.id, { title: `eval ${c.id} · ${v.name}`, titleCustom: source?.titleCustom ?? false });
	let history: NonNullable<EvalCase['history']> = c.history ?? [];
	let prompt = c.prompt;
	let compaction: { compactSummary: string | null; compactedUpTo: number } | null = null;
	if (c.fromChat) {
		history = liftHistory(c.fromChat, ctx.userId);
		// A long chat runs on its compaction summary plus the recent turns, so
		// the replay does too; the whole transcript could be past the model's
		// window, and would be a different request from the one production makes.
		if (source?.compactSummary) {
			compaction = { compactSummary: source.compactSummary, compactedUpTo: source.compactedUpTo };
		}
		const last = history.findLastIndex((m) => m.role === 'user');
		if (!prompt && last !== -1) {
			prompt = history[last].content;
			history = history.slice(0, last);
		}
	}
	if (!prompt) throw new Error(`Case ${c.id} has no prompt.`);
	for (const turn of history) {
		appendMessage(chat.id, {
			role: turn.role,
			content: turn.content,
			...(turn.evidence ? { evidence: turn.evidence } : {})
		});
	}
	appendMessage(chat.id, { role: 'user', content: prompt });
	if (compaction) {
		updateChat(chat.id, {
			compactSummary: compaction.compactSummary,
			compactedUpTo: Math.min(compaction.compactedUpTo, history.length)
		});
	}
	return { chat: getChat(chat.id, ctx.userId)!, prompt };
}

/**
 * The user and assistant turns of a chat this person owns, oldest first, with
 * the evidence the replies kept: getMessages leaves it out on purpose, and a
 * follow-up replayed without it would not be the follow-up production runs.
 */
function liftHistory(chatId: string, userId: string): NonNullable<EvalCase['history']> {
	if (!getChat(chatId, userId)) throw new Error(`No chat ${chatId} belonging to ${userId}.`);
	return db
		.select({ role: messages.role, content: messages.content, evidence: messages.evidence })
		.from(messages)
		.where(eq(messages.chatId, chatId))
		.orderBy(asc(messages.seq))
		.all()
		.filter((m): m is typeof m & { role: 'user' | 'assistant' } => m.role === 'user' || m.role === 'assistant')
		.map((m) => ({ role: m.role, content: m.content, ...(m.evidence?.length ? { evidence: m.evidence } : {}) }));
}

function modelsFor(v: Variant, ctx: RunContext) {
	const id = v.modelId ?? ctx.modelId;
	if (ctx.models) return ctx.models(id);
	return id ? { choice: pickModel(id, 'chat'), backup: null } : chatModels();
}

/** One case under one variant, through the path a real chat turn takes. */
export async function runCase(c: EvalCase, v: Variant, ctx: RunContext): Promise<CaseResult> {
	const meter: Meter = {
		started: Date.now(),
		ttft: null,
		calls: 0,
		promptTokens: 0,
		completionTokens: 0,
		reasoningTokens: 0,
		cost: 0,
		unpriced: false,
		effort: 'not sent'
	};
	const base = {
		caseId: c.id,
		variant: v.name,
		prompt: c.prompt,
		expect: c.expect ?? ''
	};
	const { choice, backup } = modelsFor(v, ctx);
	if (!choice) return finish(base, meter, '', '(none)', false, 'No usable chat model.');

	const seeded = seedChat(c, v, ctx);
	const chat = seeded.chat;
	base.prompt = seeded.prompt;
	// Spend is logged under its own task, so it shows apart from real chat in
	// Admin → Spend and still counts against the cap.
	const job = createJob({ chatId: chat.id, userId: ctx.userId, task: 'eval', persist: true });
	const turn = prepareChatTurn({
		chat,
		userId: ctx.userId,
		choice,
		job,
		webSearch: c.webSearch ?? false,
		overrides: v.overrides
	});
	let reply = '';
	let usedModel = choice.model.modelKey;
	let failover = false;
	meter.started = Date.now();
	try {
		await runAgentLoop({
			job,
			task: 'eval',
			userId: ctx.userId,
			chatId: chat.id,
			persist: true,
			primary: metered(choice, meter, ctx),
			backup: backup ? metered(backup, meter, ctx) : null,
			tools: ctx.liveTools ? frozen(turn.tools, c, NEVER_LIVE) : frozen(turn.tools, c),
			maxIterations: chatMaxSteps(),
			reasoning: turn.reasoning,
			...(turn.provider ? { provider: turn.provider } : {}),
			budgetBlocked: () => ctx.spent.usd >= ctx.maxUsd,
			buildMessages: () =>
				buildContext({
					systemPrompt: turn.fullSystemPrompt,
					chat: getChat(chat.id, ctx.userId)!,
					history: getMessages(chat.id),
					supportsVision: choice.model.supportsVision,
					tail: turn.tail
				}),
			onDone: (text, _usage, used) => {
				reply = text;
				usedModel = used.model.modelKey;
				failover = used.model.id !== choice.model.id;
			}
		});
	} catch (err) {
		return finish(base, meter, reply, usedModel, failover, String(err));
	}
	const failed = job.chunks.find((ch): ch is { type: 'error'; message: string } => ch.type === 'error');
	return finish(base, meter, reply, usedModel, failover, failed?.message ?? null);
}

function finish(
	base: Pick<CaseResult, 'caseId' | 'variant' | 'prompt' | 'expect'>,
	m: Meter,
	reply: string,
	model: string,
	failover: boolean,
	error: string | null
): CaseResult {
	return {
		...base,
		reply,
		model,
		ttftMs: m.ttft,
		totalMs: Date.now() - m.started,
		calls: m.calls,
		promptTokens: m.promptTokens,
		completionTokens: m.completionTokens,
		reasoningTokens: m.reasoningTokens,
		costUsd: m.unpriced ? null : Math.round(m.cost * 1e6) / 1e6,
		failover,
		effortSent: m.effort,
		bannedHits: countBanned(reply, bannedPhrases(languageSettings().voice)),
		error
	};
}

/**
 * The request a case would send, as the provider would receive it, with no
 * model called. Image data is replaced by its size; nothing in it is a
 * credential, since keys travel in headers and this is only the body.
 */
export function dumpRequest(c: EvalCase, v: Variant, ctx: RunContext): Record<string, unknown> {
	const { choice } = modelsFor(v, ctx);
	if (!choice) throw new Error('No usable chat model.');
	const { chat } = seedChat(c, v, ctx);
	const job = createJob({ chatId: chat.id, userId: ctx.userId, task: 'eval', persist: false });
	const turn = prepareChatTurn({ chat, userId: ctx.userId, choice, job, webSearch: c.webSearch ?? false, overrides: v.overrides });
	const sent = buildContext({
		systemPrompt: turn.fullSystemPrompt,
		chat,
		history: getMessages(chat.id),
		supportsVision: choice.model.supportsVision,
		tail: turn.tail
	});
	if (choice.model.supportsTools && turn.tools.length) withBudgetNote(sent, chatMaxSteps(), turn.tools);
	const req: ChatRequest = {
		modelKey: choice.model.modelKey,
		messages: sent,
		tools: choice.model.supportsTools ? turn.tools.map((t) => t.def) : [],
		cacheMode: choice.model.cacheMode,
		reasoning: reasoningFor(choice, turn.reasoning),
		...(turn.provider ? { provider: turn.provider } : {})
	};
	return redact(requestBody(req, true)) as Record<string, unknown>;
}

function redact(value: unknown): unknown {
	if (typeof value === 'string') {
		const data = /^data:([^;,]+);base64,(.*)$/s.exec(value);
		return data ? `[${data[1]}, ${Math.round((data[2].length * 3) / 4)} bytes]` : value;
	}
	if (Array.isArray(value)) return value.map(redact);
	if (value && typeof value === 'object') {
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v)]));
	}
	return value;
}

/**
 * The quoted phrases in the owner's Language voice, the ones it names as
 * padding, skipping the sentence shapes written with placeholders ("It is not
 * X, it is Y"), which a substring cannot find.
 */
export function bannedPhrases(voice: string): string[] {
	return [...voice.matchAll(/"([^"]{2,60})"/g)]
		.map((m) => m[1].trim())
		.filter((p) => !/\b[XYZ]\b/.test(p));
}

/**
 * How often a reply uses them, and the em dash the voice also bans. A crude
 * count, reported beside the owner's scores and never instead of them: fewer
 * banned words is not a better reply.
 */
export function countBanned(reply: string, phrases: string[]): number {
	const text = reply.toLowerCase();
	let hits = (reply.match(/—/g) ?? []).length;
	for (const phrase of phrases) {
		const needle = phrase.toLowerCase();
		for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) hits++;
	}
	return hits;
}

const SCORES = ['usefulness', 'judgement', 'style', 'adherence', 'continuity', 'completion'];

/**
 * Write a run: one file per case and variant, a CSV of the numbers with empty
 * columns for the owner's scores, and a blind sheet with the variants shuffled
 * per case under letters, its key in a separate file.
 */
export function writeRun(dir: string, results: CaseResult[], runName: string): void {
	mkdirSync(dir, { recursive: true });
	for (const r of results) {
		const caseDir = join(dir, safe(r.caseId));
		mkdirSync(caseDir, { recursive: true });
		writeFileSync(
			join(caseDir, `${safe(r.variant)}.md`),
			[
				`# ${r.caseId} · ${r.variant}`,
				'',
				'## Prompt',
				r.prompt,
				...(r.expect ? ['', '## What a good reply does', r.expect] : []),
				'',
				'## Reply',
				r.error ? `(failed: ${r.error})\n\n${r.reply}` : r.reply,
				'',
				'## Numbers',
				`model ${r.model}; first text after ${r.ttftMs ?? '–'} ms, done after ${r.totalMs} ms; ${r.calls} model calls; ` +
					`${r.promptTokens} prompt, ${r.completionTokens} completion (${r.reasoningTokens} reasoning) tokens; ` +
					`cost ${r.costUsd === null ? 'unpriced' : `$${r.costUsd}`}; effort sent ${r.effortSent}; ` +
					`failover ${r.failover ? 'yes' : 'no'}; banned-phrase hits ${r.bannedHits}`
			].join('\n')
		);
	}
	const head = [
		'case', 'variant', 'model', 'effort_sent', 'ttft_ms', 'total_ms', 'calls', 'prompt_tokens',
		'completion_tokens', 'reasoning_tokens', 'cost_usd', 'failover', 'banned_hits', 'error', ...SCORES
	];
	const rows = results.map((r) =>
		[
			r.caseId, r.variant, r.model, r.effortSent, r.ttftMs ?? '', r.totalMs, r.calls, r.promptTokens,
			r.completionTokens, r.reasoningTokens, r.costUsd ?? '', r.failover, r.bannedHits, r.error ?? '',
			...SCORES.map(() => '')
		].map(csv).join(',')
	);
	writeFileSync(join(dir, 'results.csv'), [head.join(','), ...rows].join('\n') + '\n');

	const blind: string[] = [`# Blind comparison · ${runName}`, '', 'Score each reply without looking at blind-key.json.'];
	const key: Record<string, Record<string, string>> = {};
	for (const caseId of [...new Set(results.map((r) => r.caseId))]) {
		const replies = shuffle(results.filter((r) => r.caseId === caseId), `${runName}:${caseId}`);
		key[caseId] = {};
		blind.push('', `## ${caseId}`, '', replies[0].prompt);
		replies.forEach((r, i) => {
			const letter = String.fromCharCode(65 + i);
			key[caseId][letter] = r.variant;
			blind.push('', `### ${letter}`, '', r.error ? `(failed: ${r.error})` : r.reply);
		});
	}
	writeFileSync(join(dir, 'blind.md'), blind.join('\n') + '\n');
	writeFileSync(join(dir, 'blind-key.json'), JSON.stringify(key, null, 2) + '\n');
}

const safe = (s: string) => s.replace(/[^a-z0-9._-]+/gi, '-').slice(0, 80);

function csv(value: unknown): string {
	const s = String(value);
	return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/** Shuffled the same way every time for the same seed, so a sheet can be rebuilt. */
function shuffle<T>(items: T[], seed: string): T[] {
	let h = 2166136261;
	for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
	const out = [...items];
	for (let i = out.length - 1; i > 0; i--) {
		h = Math.imul(h ^ (h >>> 15), 2246822507);
		const j = Math.abs(h) % (i + 1);
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

/** Replies people rated down, newest first, as starting points for cases. */
export function listFeedback(rating: 'up' | 'down', userId?: string) {
	const rows = db
		.select({ chatId: messages.chatId, seq: messages.seq, content: messages.content, userId: chats.userId, title: chats.title })
		.from(messages)
		.innerJoin(chats, eq(chats.id, messages.chatId))
		.where(and(eq(messages.feedback, rating), ...(userId ? [eq(chats.userId, userId)] : [])))
		.orderBy(desc(messages.createdAt))
		.all();
	return rows.map((r) => {
		const before = getMessages(r.chatId)
			.filter((m) => m.seq < r.seq && m.role === 'user')
			.at(-1);
		return {
			chatId: r.chatId,
			userId: r.userId,
			title: r.title,
			asked: (before?.content ?? '').slice(0, 160),
			replied: r.content.slice(0, 160)
		};
	});
}
