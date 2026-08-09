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
	DEFAULT_FETCH,
	DEFAULT_WEB_SEARCH,
	getSetting,
	type FetchSettings,
	type WebSearchSettings
} from '$lib/server/settings';
import { assertBudget } from './budget';
import { buildContext } from './context';
import { maybeCompact } from './compaction';
import { maybeTitleChat, nameThisChatNote, setChatTitleTool } from './chat-title';
import { createJob, failJob, type LiveJob } from './jobs';
import { runAgentLoop, type LoopTool } from './loop';
import { previousRunNote, runHistoryTool } from './run-history';
import { askUserTool } from './ask-user';
import { attachmentTools } from './tools/attachments';
import { boardTools } from './tools/boards';
import { fetchUrlTool } from './tools/fetch-url';
import { bootstrapContext, knowledgeTools } from './tools/knowledge';
import { mcpLoopTools } from './tools/mcp';
import { applyToolPolicy } from './tools/registry';
import { webSearchConfigured, webSearchTool } from './tools/web-search';

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
	// Remember the model actually used, so reopening this chat restores it
	// rather than inheriting whatever the composer was last set to.
	updateChat(chat.id, { modelId: choice.model.id });

	const persist = !chat.hidden;
	const job = createJob({ chatId: chat.id, userId: opts.userId, task: 'chat', persist });

	const searchCfg = getSetting<WebSearchSettings>('websearch', DEFAULT_WEB_SEARCH);
	const tools: LoopTool[] = [
		...knowledgeTools(opts.userId),
		...attachmentTools(chat.id),
		// Deliberately not behind the web-search toggle. That toggle governs
		// *looking things up*; this is for reading an address the user has already
		// handed over, and turning search off should not make the model guess at a
		// link it was given. Admin → Tools switches it off outright.
		fetchUrlTool(getSetting<FetchSettings>('fetch', DEFAULT_FETCH)),
		runHistoryTool(chat.id),
		// Scoped to this user's boards and anything shared with them.
		...boardTools(opts.userId),
		// The turn parks on the promise this returns until the browser answers.
		askUserTool(job)
	];

	/**
	 * Naming happens inside this turn when the chat is still unnamed: the agent
	 * that writes the reply also names the conversation, in one call. The
	 * separate titling pass below is only a fallback for when it doesn't — a
	 * second model call is a second thing that can fail on its own, which is
	 * exactly how chats ended up keeping their truncated first message.
	 */
	const needsName =
		!chat.titleCustom && !getMessages(chat.id).some((m) => m.role === 'assistant');
	let namedItself = false;
	if (needsName) {
		tools.push(setChatTitleTool(chat.id, opts.userId, () => (namedItself = true)));
	}
	if (opts.webSearch && webSearchConfigured(searchCfg)) {
		// Built per turn: the tool carries a per-turn memo and search budget in
		// its closure. A provider failure still throws and reaches the model as
		// an error, rather than being flattened into "no results".
		tools.push(webSearchTool(searchCfg));
	}
	// Read before the turn starts, so it describes the *previous* attempt and
	// stays fixed for the whole of this one.
	const fullSystemPrompt =
		systemPrompt +
		bootstrapContext(opts.userId) +
		previousRunNote(chat.id) +
		(needsName ? nameThisChatNote() : '');
	const activeTools = applyToolPolicy([...tools, ...mcpLoopTools('chat')], 'chat');

	void runAgentLoop({
		job,
		task: 'chat',
		userId: opts.userId,
		chatId: chat.id,
		persist,
		primary: choice,
		backup,
		tools: activeTools,
		maxIterations: MAX_TOOL_ITERATIONS,
		buildMessages: () =>
			buildContext({
				systemPrompt: fullSystemPrompt,
				chat: getChat(chat.id, opts.userId)!,
				history: getMessages(chat.id),
				supportsVision: choice.model.supportsVision
			}),
		onDone: (text, _usage, usedChoice, summary) => {
			const saved = appendMessage(chat.id, {
				role: 'assistant',
				content: text,
				modelKey: usedChoice.model.modelKey,
				// Kept with the reply, so a turn that searched and read three pages
				// still says so when it is scrolled back to.
				trace: summary.trace.length ? { steps: summary.trace } : null
			});
			// Compaction and titling both run after the reply so neither delays
			// streaming, and neither can fail the turn.
			void (async () => {
				// Only when the agent didn't take the offer.
				if (!namedItself) {
					await maybeTitleChat(chat.id, opts.userId).catch(() => {
						// maybeTitleChat reports its own failures via events
					});
				}
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
