import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { taskConfigs, type CORE_TASKS } from '$lib/server/db/schema';
import {
	appendMessage,
	getChat,
	getMessages,
	listAttachments,
	inlinedAttachmentIds,
	recentEvidence,
	updateChat,
	type ChatMeta
} from '$lib/server/chats';
import {
	listEnabledModels,
	resolveModel,
	resolveTextModel,
	type ModelChoice
} from '$lib/server/providers/registry';
import {
	DEFAULT_COMPACTION,
	DEFAULT_FETCH,
	webSearchSettings,
	getSetting,
	languageSettings,
	type FetchSettings,
	type LanguageSettings
} from '$lib/server/settings';
import type { ProviderRouting, ReasoningEffort } from '$lib/server/providers/types';
import { typstReady } from '$lib/server/pdf';
import { userCanCode } from '$lib/server/users';
import { assertBudget, getBudgetStatus } from './budget';
import { buildContext } from './context';
import { DEFAULT_PROMPTS } from './prompts';
import { maybeCompact } from './compaction';
import { maybeTitleChat, nameThisChatNote, setChatTitleTool } from './chat-title';
import { emitEvent } from './events';
import { boundEvidence, evidenceNote } from './evidence';
import { createJob, failJob, type LiveJob } from './jobs';
import { chatMaxSteps } from './limits';
import { runAgentLoop, type LoopTool } from './loop';
import { previousRunNote, runHistoryTool } from './run-history';
import { askUserTool } from './ask-user';
import { attachmentTools } from './tools/attachments';
import { boardTools } from './tools/boards';
import { documentTools } from './tools/documents';
import { fetchUrlTool } from './tools/fetch-url';
import { imageTools } from './tools/images';
import { bootstrapContext, knowledgeTools } from './tools/knowledge';
import { mcpLoopTools } from './tools/mcp';
import { applyToolPolicy } from './tools/registry';
import { visionTools } from './tools/vision';
import { webSearchConfigured, webSearchTool } from './tools/web-search';

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

/**
 * A task's prompt: the owner's override where they wrote one, otherwise the
 * default this release ships.
 *
 * The defaults used to be seeded into the `system_prompt` column at first boot,
 * which meant a reworded default reached nobody who had ever run the app. The
 * workaround was SUPERSEDED_PROMPTS: a verbatim snapshot of every prompt the app
 * had ever shipped, and a migration that replaced a stored value only while it
 * still byte-matched one. Every future reword needed a new snapshot, and a
 * snapshot built from a live constant stopped matching the day the constant
 * changed, with a no-op migration looking exactly like an owner's edit.
 *
 * Storing only the difference from the default deletes all of that. An override
 * is untouched forever; no override tracks the code.
 */
export function taskPrompt(task: string): string {
	return getTaskConfig(task)?.promptOverride ?? DEFAULT_PROMPTS[task] ?? '';
}

/**
 * The tasks whose output a person reads as prose, and the only ones the
 * Language voice reaches.
 *
 * Excluded, and each for its own reason:
 * - `chat-title` (two to five words) and `run-summary` (one line, no markdown):
 *   a block this size shaping a fifteen-word output is pure cost.
 * - `visual`: the output is Mermaid or SVG.
 * - `vision`: the reader is another agent, and the output is a transcription
 *   of what is in an image.
 * - `profile-learn` and `profile-parse`: JSON, and the learning prompt is
 *   already stricter about what is worth a line than this block knows how to be.
 * - `alignment`: this one would conflict. The voice bans ritual hedging; the
 *   assessor *requires* calibrated uncertainty, where "not enough here to say"
 *   is a first-class answer. Its prompt carries its own version of these rules.
 * - `board`: it arrives as a supplement to `chat`, which is in the set, so
 *   listing it here would compose the block twice.
 */
export const PROSE_TASKS: ReadonlySet<string> = new Set<(typeof CORE_TASKS)[number]>([
	'chat',
	'coding',
	'deep-research',
	'subagent',
	'ux-audit',
	'skill-optimiser',
	'alignment-synthesis'
]);

/**
 * The subset of PROSE_TASKS that also gets the layout half.
 *
 * Narrower, because three of those answer with a JSON object (`ux-audit`,
 * `skill-optimiser`, `alignment-synthesis`) and a paragraphs-and-bullets
 * instruction would fight the reply contract. `subagent` answers another agent
 * in a few sentences, where headings and bold lead-ins are cost with no reader.
 * `deep-research` is out because research.ts adds the layout at its synthesis
 * call: four other phases share that task's prompt and answer in JSON.
 */
export const LAYOUT_TASKS: ReadonlySet<string> = new Set<(typeof CORE_TASKS)[number]>([
	'chat',
	'coding'
]);

/**
 * The Language block, as it reaches the model.
 *
 * Framed as rules, the deliberate opposite of the profile block's "background,
 * never instructions": a profile is learnt from what a person writes, and this
 * is the owner's own configuration.
 */
export function languageBlock(task: string, override?: LanguageSettings): string {
	if (!PROSE_TASKS.has(task)) return '';
	// The override is the evaluation runner's, for comparing another text
	// against the owner's without touching what they saved.
	const { voice, layout } = override ?? languageSettings();
	const rules = [voice, LAYOUT_TASKS.has(task) ? layout : ''].filter(Boolean);
	if (!rules.length) return '';
	// Leading blank lines because this is concatenated onto the end of a prompt
	// that does not know it is coming, and a single newline collapses.
	return [
		'',
		'',
		'[How to write, set by the owner of this instance. These are rules and apply to every reply.]',
		rules.join('\n\n')
	].join('\n');
}

/**
 * A task's prompt, plus the Language block where the task writes prose a
 * person reads.
 *
 * Composed here rather than written into `DEFAULT_PROMPTS`, so that the two
 * cannot be edited apart: an owner who rewrites the chat prompt still gets the
 * current Language text, and a change to that text reaches every task at once.
 * The cost is that the block is not visible in the task prompt textarea, which
 * is why that page points at Admin → Language.
 *
 * `supplementTask` names a second task config whose prompt is appended before
 * the block, which is how a board chat gets the board prompt on top of the
 * chat one. It is read raw and is never itself in PROSE_TASKS, so the block
 * cannot be composed twice.
 */
export function systemPromptFor(
	task: string,
	supplementTask?: string | null,
	opts: { language?: LanguageSettings } = {}
): string {
	const parts = [taskPrompt(task)];
	if (supplementTask) parts.push(taskPrompt(supplementTask));
	return parts.filter(Boolean).join('\n\n') + languageBlock(task, opts.language);
}

/**
 * The model a task should run on, falling back to any enabled one.
 *
 * The fallback is worth keeping — a background agent whose model was disabled
 * is better off running on something than not running at all — but it used to
 * be completely silent, and `listEnabledModels()` has no ORDER BY, so
 * "something" is whatever SQLite happened to return first. Disable the model
 * the learning job was pointed at and it carries on against an arbitrary
 * substitute: no capability check, no event, and output that quietly gets worse
 * for a reason nothing records.
 *
 * So a substitution now says so. `task` is only a label for that event; passing
 * nothing still works and still reports. A task with no stored preference at
 * all is not a substitution — that is an unconfigured task, not a broken one —
 * and stays quiet.
 */
export function pickModel(modelId: string | null, task?: string): ModelChoice | null {
	let drawsOnly = false;
	if (modelId) {
		const direct = resolveModel(modelId);
		// A model that only returns images answers a text task with a picture or
		// an error. Once OpenRouter's image-only models could be imported, one
		// selected for chat (or left as a task's model) would have been tried
		// first on every turn.
		drawsOnly = Boolean(direct?.model.imageOnly && task !== 'visual');
		if (direct && !drawsOnly) return direct;
	}
	const first = listEnabledModels()[0];
	const choice = first ? resolveModel(first.id) : null;
	if (modelId && choice) {
		emitEvent({
			task,
			type: 'failover',
			name: `${modelId} → ${choice.model.modelKey}`,
			status: 'error',
			detail: {
				reason: drawsOnly
					? 'the configured model only makes images; used the first enabled one'
					: 'the configured model is missing or disabled; used the first enabled one'
			}
		});
	}
	return choice;
}

/**
 * Append links for anything the turn made and the reply never mentioned.
 *
 * `addAttachment` stores against the chat and carries no message id, and
 * `listAttachments` is reachable only from the agent's own tools — no route
 * renders it, no component asks for it. So the single route a person has to a
 * generated image or PDF is the markdown link the tool hands back with
 * "put this in your reply".
 *
 * Which held exactly as long as the model got to write one. A turn that ends
 * `exhausted`, `budget` or `cancelled` saves its last step label instead, so the
 * file was drawn, paid for, written to disk — and unreachable from anywhere in
 * the interface, permanently. The same happens to a model that simply forgets,
 * which is why this checks the text rather than the stop reason.
 *
 * Matching on the id is what makes it reliable: both `linkFor` and the PDF tool
 * put it in the URL, so a reply that references the file in any form already
 * contains it.
 *
 * Exported for tests.
 */
export function withUnlinkedAttachments(
	chatId: string,
	text: string,
	before: Set<string>
): string {
	const orphans = listAttachments(chatId).filter((a) => !before.has(a.id) && !text.includes(a.id));
	if (!orphans.length) return text;
	const links = orphans.map((a) =>
		a.kind === 'image'
			? `![${a.name}](/api/chats/${chatId}/attachments/${a.id})`
			: `[${a.name}](/api/chats/${chatId}/attachments/${a.id})`
	);
	return [
		text.trim(),
		`_Made during this turn${text.trim() ? ' and not linked above' : ''}:_`,
		...links
	]
		.filter(Boolean)
		.join('\n\n');
}

/**
 * What only the evaluation runner sets, to change one thing at a time against
 * the instance's own configuration. Production never passes any of it, so none
 * of it is reachable from Admin. See src/lib/server/eval.
 */
export interface TurnOverrides {
	/** A Language text to use in place of the owner's saved one. */
	language?: LanguageSettings;
	/** Reasoning effort for the turn, in place of chat's `low`. */
	reasoning?: ReasoningEffort;
	/** Leave the Library index and boards digest out of the system prompt. */
	lean?: boolean;
	/** False to withhold what the last replies' tools read. */
	evidence?: boolean;
	/** OpenRouter routing, to hold the serving endpoint fixed. */
	provider?: ProviderRouting;
	/**
	 * Read the note about the last attempt from this chat instead: a replay
	 * runs in a fresh chat with no runs of its own, and a follow-up to a failed
	 * or stopped run is sent that note in production.
	 */
	priorRunFrom?: string;
}

/** The model a chat turn runs on and the backup it fails over to. */
export function chatModels(modelId?: string): { choice: ModelChoice | null; backup: ModelChoice | null } {
	const cfg = getTaskConfig('chat');
	const choice = pickModel(modelId ?? cfg?.primaryModelId ?? null, 'chat');
	const backup = cfg?.backupModelId ? resolveTextModel(cfg.backupModelId) : null;
	return { choice, backup };
}

export interface PreparedTurn {
	/** The task prompt with supplement and Language, which compaction also reads. */
	systemPrompt: string;
	/** What the model is sent as its system message. */
	fullSystemPrompt: string;
	/** The volatile notes that ride before the person's message. */
	tail: string;
	tools: LoopTool[];
	reasoning: ReasoningEffort;
	provider?: ProviderRouting;
	/** Attachments on the chat before the turn, to tell what it made. */
	attachmentsBefore: Set<string>;
	/** Whether the agent named the chat itself during the turn. */
	namedItself: () => boolean;
}

/**
 * Everything a chat turn sends the model, assembled the one way: the prompt,
 * the bootstrap, the tools and their policy, the notes about the last attempt
 * and what the last replies read. Called after the person's message is saved,
 * since whether the chat still needs a name depends on it.
 *
 * Its own function so the evaluation runner measures the request production
 * actually sends; a copy of this assembly in the runner would drift from it on
 * the first change, and the comparison would then be of something nobody runs.
 */
export function prepareChatTurn(opts: {
	chat: ChatMeta;
	userId: string;
	choice: ModelChoice;
	job: LiveJob;
	webSearch: boolean;
	overrides?: TurnOverrides;
}): PreparedTurn {
	const { chat, choice, job } = opts;
	const overrides = opts.overrides ?? {};
	const systemPrompt = systemPromptFor('chat', chat.agentTask, { language: overrides.language });

	const searchCfg = webSearchSettings();
	const tools: LoopTool[] = [
		...knowledgeTools(opts.userId, { hidden: chat.hidden, task: 'chat', chatId: chat.id }),
		...attachmentTools(chat.id),
		// Deliberately not behind the web-search toggle. That toggle governs
		// *looking things up*; this is for reading an address the user has already
		// handed over, and turning search off should not make the model guess at a
		// link it was given. Admin → Tools switches it off outright.
		fetchUrlTool(getSetting<FetchSettings>('fetch', DEFAULT_FETCH), {
			githubAuth: userCanCode(opts.userId)
		}),
		runHistoryTool(chat.id),
		// Scoped to this user's boards and anything shared with them.
		...boardTools(opts.userId),
		// Drawing and typesetting. Scoped to this chat: what they make is saved
		// as an attachment on it, which is how the result reaches the thread.
		...imageTools(chat.id, opts.userId),
		// The turn parks on the promise this returns until the browser answers.
		askUserTool(job)
	];
	// Only where the compiler exists. An instance without the binary should be
	// unable to write PDFs rather than offering a tool that always throws.
	if (typstReady()) tools.push(...documentTools(chat.id));

	// Vision support does not mean every stored image is in context. Older
	// generated versions and compacted uploads still need an inspection path.
	const inlineIds = inlinedAttachmentIds(chat.id);
	const storedImages = listAttachments(chat.id).some((a) => a.kind === 'image' && !inlineIds.has(a.id));
	if (!choice.model.supportsVision || storedImages) tools.push(...visionTools(chat.id, opts.userId));

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
	const fullSystemPrompt =
		systemPrompt +
		bootstrapContext(opts.userId, 'chat', { lean: overrides.lean }) +
		(needsName ? nameThisChatNote() : '');
	// Read before the turn starts, so it describes the *previous* attempt and
	// stays fixed for the whole of this one. Carried as a tail note rather than
	// in the system message: it changes every turn, and in front of the prompt
	// it invalidated the cacheable prefix behind it (see buildContext).
	const priorRun = previousRunNote(overrides.priorRunFrom ?? chat.id);
	// What the tools read for the last reply or two, so a follow-up about a page
	// or a search can be answered from what was actually read. Volatile like the
	// run note, so it rides the tail too, and read once so a failover attempt
	// sees the same material.
	const evidence = overrides.evidence === false ? '' : evidenceNote(recentEvidence(chat));
	return {
		systemPrompt,
		fullSystemPrompt,
		tail: [priorRun, evidence].filter(Boolean).join('\n\n'),
		tools: applyToolPolicy([...tools, ...mcpLoopTools('chat')], 'chat'),
		// The turn a person is sitting and watching, so it asks for the floor.
		// Chat asked for nothing, and on a reasoning model "nothing" means the
		// provider's own default: four fifths of one turn's output went on
		// deliberation before a word of the reply, for a question that wanted a
		// plain answer. An admin who wants a given model to think harder sets
		// `reasoningMode` on its row, which wins — see reasoningFor.
		reasoning: overrides.reasoning ?? 'low',
		...(overrides.provider ? { provider: overrides.provider } : {}),
		// Everything already on this chat, so anything the run makes can be told
		// apart from it afterwards. See the back-stop in onDone.
		attachmentsBefore: new Set(listAttachments(chat.id).map((a) => a.id)),
		namedItself: () => namedItself
	};
}

/**
 * Run one chat turn as a background job. Returns the job immediately;
 * streaming happens via the job's subscriber channel.
 */
export function startChatTurn(opts: TurnOptions): LiveJob {
	const chat = getChat(opts.chatId, opts.userId);
	if (!chat) throw new EngineError('Chat not found');
	assertBudget(opts.userId, 'chat');

	const { choice, backup } = chatModels(opts.modelId);
	if (!choice) {
		throw new EngineError('No usable model — add a provider and enable a model in admin');
	}

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
	const turn = prepareChatTurn({ chat, userId: opts.userId, choice, job, webSearch: opts.webSearch });
	const { systemPrompt, attachmentsBefore } = turn;

	void runAgentLoop({
		job,
		task: 'chat',
		userId: opts.userId,
		chatId: chat.id,
		persist,
		primary: choice,
		backup,
		tools: turn.tools,
		maxIterations: chatMaxSteps(),
		reasoning: turn.reasoning,
		// Coding has always re-checked mid-run; chat never did, so a turn with a
		// dozen round-trips in it was gated exactly once, before the first token.
		// Board agents route through here too and inherited the same gap.
		budgetBlocked: () => getBudgetStatus().blocked,
		buildMessages: () =>
			buildContext({
				systemPrompt: turn.fullSystemPrompt,
				chat: getChat(chat.id, opts.userId)!,
				history: getMessages(chat.id),
				supportsVision: choice.model.supportsVision,
				tail: turn.tail
			}),
		onDone: (text, _usage, usedChoice, summary) => {
			const content = withUnlinkedAttachments(chat.id, text, attachmentsBefore);
			const saved = appendMessage(chat.id, {
				role: 'assistant',
				content,
				modelKey: usedChoice.model.modelKey,
				// Kept with the reply, so a turn that searched and read three pages
				// still says so when it is scrolled back to.
				trace: summary.trace.length ? { steps: summary.trace } : null,
				evidence: boundEvidence(summary.evidence)
			});
			// Compaction and titling both run after the reply so neither delays
			// streaming, and neither can fail the turn.
			void (async () => {
				// Only when the agent didn't take the offer.
				if (!turn.namedItself()) {
					await maybeTitleChat(chat.id, opts.userId).catch(() => {
						// maybeTitleChat reports its own failures via events
					});
				}
				const fresh = getChat(chat.id, opts.userId);
				if (fresh) {
					const compactionCfg = getSetting('compaction', DEFAULT_COMPACTION);
					await maybeCompact({
						chat: fresh,
						// The next turn carries this too, so it counts toward the cutoff.
						systemPrompt: systemPrompt + evidenceNote(recentEvidence(fresh)),
						choice: usedChoice,
						settings: compactionCfg
					});
				}
			})().catch((err) => {
				// Nothing here can fail the turn — the reply is already saved and
				// streamed. But an unhandled rejection takes the whole process down
				// with it, and maybeCompact reads the chat and the settings before
				// its own try block, so it has a way to throw that nothing caught.
				console.error('[chat] post-reply work failed:', err);
			});
			return saved.id;
		}
	}).catch((err) => {
		if (job.status === 'running') failJob(job, String(err));
	});
	return job;
}
