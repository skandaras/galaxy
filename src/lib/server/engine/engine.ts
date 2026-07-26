import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { taskConfigs } from '$lib/server/db/schema';
import { appendMessage, getChat, getMessages, updateChat } from '$lib/server/chats';
import {
	listEnabledModels,
	resolveModel,
	type ModelChoice
} from '$lib/server/providers/registry';
import {
	DEFAULT_COMPACTION,
	DEFAULT_WEB_SEARCH,
	getSetting,
	type WebSearchSettings
} from '$lib/server/settings';
import { assertBudget } from './budget';
import { buildContext } from './context';
import { maybeCompact } from './compaction';
import { createJob, failJob, type LiveJob } from './jobs';
import { runAgentLoop, type LoopTool } from './loop';
import { bootstrapContext, knowledgeTools } from './tools/knowledge';
import { runWebSearch, webSearchConfigured, webSearchToolDef } from './tools/web-search';

const MAX_TOOL_ITERATIONS = 6;

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

export function getTaskConfig(task: string) {
	return db.select().from(taskConfigs).where(eq(taskConfigs.task, task)).get();
}

export function pickModel(modelId: string | null): ModelChoice | null {
	if (modelId) {
		const direct = resolveModel(modelId);
		if (direct) return direct;
	}
	const first = listEnabledModels()[0];
	return first ? resolveModel(first.id) : null;
}

/**
 * Run one chat turn as a background job. Returns the job immediately;
 * streaming happens via the job's subscriber channel.
 */
export function startChatTurn(opts: TurnOptions): LiveJob {
	const chat = getChat(opts.chatId, opts.userId);
	if (!chat) throw new EngineError('Chat not found');
	assertBudget(opts.userId, 'chat');

	const cfg = getTaskConfig('chat');
	const choice = pickModel(opts.modelId ?? cfg?.primaryModelId ?? null);
	if (!choice) {
		throw new EngineError('No usable model — add a provider and enable a model in admin');
	}
	const backup = cfg?.backupModelId ? resolveModel(cfg.backupModelId) : null;
	const systemPrompt = cfg?.systemPrompt ?? '';

	appendMessage(chat.id, {
		role: 'user',
		content: opts.content,
		attachments: opts.attachments
	});
	if (chat.title === 'New chat') {
		updateChat(chat.id, { title: opts.content.slice(0, 48) || 'New chat' });
	}

	const persist = !chat.hidden;
	const job = createJob({ chatId: chat.id, userId: opts.userId, task: 'chat', persist });

	const searchCfg = getSetting<WebSearchSettings>('websearch', DEFAULT_WEB_SEARCH);
	const tools: LoopTool[] = [...knowledgeTools()];
	if (opts.webSearch && webSearchConfigured(searchCfg)) {
		tools.push({
			def: webSearchToolDef,
			describe: (args) => String(args.query ?? ''),
			execute: async (args, report) => {
				const outcome = await runWebSearch(String(args.query ?? ''), searchCfg);
				report?.({
					provider: outcome.provider,
					results: outcome.results.length,
					...(outcome.failedOver ? { failedOver: outcome.failedOver } : {})
				});
				// An empty list is a real answer; a provider failure throws and is
				// surfaced to the model as an error rather than as "no results".
				return JSON.stringify(outcome.results);
			}
		});
	}
	const fullSystemPrompt = systemPrompt + bootstrapContext(opts.userId);

	void runAgentLoop({
		job,
		task: 'chat',
		userId: opts.userId,
		chatId: chat.id,
		persist,
		primary: choice,
		backup,
		tools,
		maxIterations: MAX_TOOL_ITERATIONS,
		buildMessages: () =>
			buildContext({
				systemPrompt: fullSystemPrompt,
				chat: getChat(chat.id, opts.userId)!,
				history: getMessages(chat.id),
				supportsVision: choice.model.supportsVision
			}),
		onDone: (text, _usage, usedChoice) => {
			const saved = appendMessage(chat.id, {
				role: 'assistant',
				content: text,
				modelKey: usedChoice.model.modelKey
			});
			// Compaction runs after the reply so it never delays streaming.
			void (async () => {
				const fresh = getChat(chat.id, opts.userId);
				if (fresh) {
					const compactionCfg = getSetting('compaction', DEFAULT_COMPACTION);
					await maybeCompact({
						chat: fresh,
						systemPrompt,
						choice: usedChoice,
						settings: compactionCfg
					});
				}
			})();
			return saved.id;
		}
	}).catch((err) => {
		if (job.status === 'running') failJob(job, String(err));
	});
	return job;
}
