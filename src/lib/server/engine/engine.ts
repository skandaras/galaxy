import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { taskConfigs, usageLog } from '$lib/server/db/schema';
import type { ChatMeta } from '$lib/server/chats';
import { appendMessage, getChat, getMessages, updateChat } from '$lib/server/chats';
import {
	listEnabledModels,
	resolveModel,
	type ModelChoice
} from '$lib/server/providers/registry';
import type { ProviderMessage, ToolCall, ToolDef, Usage } from '$lib/server/providers/types';
import { isRetryable } from '$lib/server/providers/types';
import {
	DEFAULT_COMPACTION,
	DEFAULT_WEB_SEARCH,
	getSetting,
	type WebSearchSettings
} from '$lib/server/settings';
import { buildContext } from './context';
import { maybeCompact } from './compaction';
import { emitEvent } from './events';
import { completeJob, createJob, failJob, pushChunk, type LiveJob } from './jobs';
import { runWebSearch, webSearchConfigured, webSearchToolDef } from './tools/web-search';

const MAX_TOOL_ITERATIONS = 6;
const REQUEST_TIMEOUT_MS = 180_000;

export interface TurnOptions {
	chatId: string;
	userId: string;
	content: string;
	attachments?: { id: string; name: string; mime: string }[];
	/** Model override for this turn; falls back to task config, then first enabled. */
	modelId?: string;
	webSearch: boolean;
}

export class EngineError extends Error {}

/**
 * Run one chat turn as a background job. Returns the job immediately;
 * streaming happens via the job's subscriber channel.
 */
export function startChatTurn(opts: TurnOptions): LiveJob {
	const chat = getChat(opts.chatId, opts.userId);
	if (!chat) throw new EngineError('Chat not found');

	const cfg = db.select().from(taskConfigs).where(eq(taskConfigs.task, 'chat')).get();
	const choice = pickModel(opts.modelId ?? cfg?.primaryModelId ?? null);
	if (!choice) {
		throw new EngineError('No usable model — add a provider and enable a model in admin');
	}
	const backup = cfg?.backupModelId ? resolveModel(cfg.backupModelId) : null;

	appendMessage(chat.id, {
		role: 'user',
		content: opts.content,
		attachments: opts.attachments
	});
	if (chat.title === 'New chat') {
		updateChat(chat.id, { title: opts.content.slice(0, 48) || 'New chat' });
	}

	const job = createJob({
		chatId: chat.id,
		userId: opts.userId,
		task: 'chat',
		persist: !chat.hidden
	});

	void runTurn(job, chat, choice, backup, cfg?.systemPrompt ?? '', opts).catch((err) => {
		// Last-resort guard: runTurn handles its own errors; this catches bugs.
		if (job.status === 'running') failJob(job, String(err));
	});
	return job;
}

function pickModel(modelId: string | null): ModelChoice | null {
	if (modelId) {
		const direct = resolveModel(modelId);
		if (direct) return direct;
	}
	const first = listEnabledModels()[0];
	return first ? resolveModel(first.id) : null;
}

async function runTurn(
	job: LiveJob,
	chat: ChatMeta,
	primary: ModelChoice,
	backup: ModelChoice | null,
	systemPrompt: string,
	opts: TurnOptions
): Promise<void> {
	const persist = !chat.hidden;
	emitEvent(
		{
			userId: opts.userId,
			chatId: chat.id,
			task: 'chat',
			type: 'job',
			name: 'chat.turn',
			status: 'running',
			detail: { jobId: job.id }
		},
		{ persist }
	);

	// Failover order: primary, primary again on a retryable error, then backup.
	const attempts: ModelChoice[] = backup ? [primary, primary, backup] : [primary, primary];
	let lastError: unknown = null;

	for (let attempt = 0; attempt < attempts.length; attempt++) {
		const choice = attempts[attempt];
		if (attempt > 0) {
			const switching = choice !== primary;
			pushChunk(job, {
				type: 'notice',
				text: switching
					? `Switched to backup model ${choice.model.displayName}`
					: `Retrying ${choice.model.displayName}…`
			});
			if (switching) {
				emitEvent(
					{
						userId: opts.userId,
						chatId: chat.id,
						task: 'chat',
						type: 'failover',
						name: `${primary.model.modelKey} → ${choice.model.modelKey}`,
						status: 'ok',
						detail: { reason: String(lastError) }
					},
					{ persist }
				);
			}
		}
		try {
			await executeWithModel(job, chat, choice, systemPrompt, opts, persist);
			return;
		} catch (err) {
			lastError = err;
			if (!isRetryable(err)) break;
		}
	}

	logUsage(opts.userId, chat.id, primary.model.modelKey, null, 'error');
	failJob(job, `Model call failed: ${String(lastError)}`);
}

async function executeWithModel(
	job: LiveJob,
	chat: ChatMeta,
	choice: ModelChoice,
	systemPrompt: string,
	opts: TurnOptions,
	persist: boolean
): Promise<void> {
	pushChunk(job, { type: 'meta', model: choice.model.displayName });

	const searchCfg = getSetting<WebSearchSettings>('websearch', DEFAULT_WEB_SEARCH);
	const tools: ToolDef[] = [];
	if (opts.webSearch && choice.model.supportsTools && webSearchConfigured(searchCfg)) {
		tools.push(webSearchToolDef);
	}

	const messages = buildContext({
		systemPrompt,
		chat: getChat(chat.id, opts.userId)!,
		history: getMessages(chat.id),
		supportsVision: choice.model.supportsVision
	});

	let assistantText = '';
	let usage: Usage | null = null;

	for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
		const started = Date.now();
		let iterationText = '';
		let toolCalls: ToolCall[] = [];

		try {
			const stream = choice.adapter.stream(
				{ modelKey: choice.model.modelKey, messages, tools },
				AbortSignal.timeout(REQUEST_TIMEOUT_MS)
			);
			for await (const ev of stream) {
				if (ev.type === 'text') {
					iterationText += ev.delta;
					pushChunk(job, { type: 'delta', text: ev.delta });
				} else if (ev.type === 'tool_calls') {
					toolCalls = ev.calls;
				} else if (ev.type === 'usage') {
					usage = addUsage(usage, ev.usage);
				}
			}
		} catch (err) {
			emitEvent(
				{
					userId: opts.userId,
					chatId: chat.id,
					task: 'chat',
					type: 'model.call',
					name: choice.model.modelKey,
					status: 'error',
					durationMs: Date.now() - started,
					detail: { error: String(err) }
				},
				{ persist }
			);
			throw err;
		}

		emitEvent(
			{
				userId: opts.userId,
				chatId: chat.id,
				task: 'chat',
				type: 'model.call',
				name: choice.model.modelKey,
				status: 'ok',
				durationMs: Date.now() - started,
				detail: usage ? { ...usage } : undefined
			},
			{ persist }
		);

		assistantText += iterationText;

		if (!toolCalls.length) break;

		messages.push({
			role: 'assistant',
			content: iterationText,
			tool_calls: toolCalls
		});
		for (const call of toolCalls) {
			const result = await executeTool(call, searchCfg, {
				userId: opts.userId,
				chatId: chat.id,
				persist,
				job
			});
			messages.push({ role: 'tool', content: result, tool_call_id: call.id });
		}
	}

	const saved = appendMessage(chat.id, {
		role: 'assistant',
		content: assistantText,
		modelKey: choice.model.modelKey
	});
	logUsage(opts.userId, chat.id, choice.model.modelKey, usage, 'ok', choice);
	emitEvent(
		{
			userId: opts.userId,
			chatId: chat.id,
			task: 'chat',
			type: 'job',
			name: 'chat.turn',
			status: 'ok',
			detail: { jobId: job.id }
		},
		{ persist }
	);

	completeJob(job, saved.id);

	// Compaction runs after the reply so it never delays streaming.
	const fresh = getChat(chat.id, opts.userId);
	if (fresh) {
		const compactionCfg = getSetting('compaction', DEFAULT_COMPACTION);
		await maybeCompact({ chat: fresh, systemPrompt, choice, settings: compactionCfg });
	}
}

async function executeTool(
	call: ToolCall,
	searchCfg: WebSearchSettings,
	ctx: { userId: string; chatId: string; persist: boolean; job: LiveJob }
): Promise<string> {
	const started = Date.now();
	pushChunk(ctx.job, { type: 'tool', name: call.name, status: 'running' });
	try {
		let result: string;
		if (call.name === 'web_search') {
			const args = safeParseArgs(call.arguments);
			const query = String(args.query ?? '');
			const results = await runWebSearch(query, searchCfg);
			result = JSON.stringify(results);
			emitEvent(
				{
					userId: ctx.userId,
					chatId: ctx.chatId,
					task: 'chat',
					type: 'tool.call',
					name: 'web_search',
					status: 'ok',
					durationMs: Date.now() - started,
					detail: { query, results: results.length, provider: searchCfg.provider }
				},
				{ persist: ctx.persist }
			);
		} else {
			result = JSON.stringify({ error: `Unknown tool: ${call.name}` });
		}
		pushChunk(ctx.job, { type: 'tool', name: call.name, status: 'ok' });
		return result;
	} catch (err) {
		emitEvent(
			{
				userId: ctx.userId,
				chatId: ctx.chatId,
				task: 'chat',
				type: 'tool.call',
				name: call.name,
				status: 'error',
				durationMs: Date.now() - started,
				detail: { error: String(err) }
			},
			{ persist: ctx.persist }
		);
		pushChunk(ctx.job, { type: 'tool', name: call.name, status: 'error', detail: String(err) });
		return JSON.stringify({ error: String(err) });
	}
}

function safeParseArgs(raw: string): Record<string, unknown> {
	try {
		return JSON.parse(raw);
	} catch {
		return {};
	}
}

function addUsage(a: Usage | null, b: Usage): Usage {
	return {
		promptTokens: (a?.promptTokens ?? 0) + b.promptTokens,
		completionTokens: (a?.completionTokens ?? 0) + b.completionTokens
	};
}

function logUsage(
	userId: string,
	chatId: string,
	modelKey: string,
	usage: Usage | null,
	status: 'ok' | 'error',
	choice?: ModelChoice
): void {
	const cost =
		usage && choice?.model.promptCostPerMTok != null && choice.model.completionCostPerMTok != null
			? (usage.promptTokens * choice.model.promptCostPerMTok +
					usage.completionTokens * choice.model.completionCostPerMTok) /
				1_000_000
			: null;
	db.insert(usageLog)
		.values({
			id: randomUUID(),
			ts: new Date(),
			userId,
			chatId,
			task: 'chat',
			modelKey,
			promptTokens: usage?.promptTokens ?? 0,
			completionTokens: usage?.completionTokens ?? 0,
			costUsd: cost,
			status
		})
		.run();
}
