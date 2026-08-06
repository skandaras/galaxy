import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { codeSessions, type AttachmentRef } from '$lib/server/db/schema';
import { appendMessage, createChat, deleteChat, getChat, getMessages, updateChat } from '$lib/server/chats';
import { resolveModel } from '$lib/server/providers/registry';
import type { ProviderMessage } from '$lib/server/providers/types';
import { assertBudget, getBudgetStatus } from '../budget';
import { EngineError, getTaskConfig, pickModel } from '../engine';
import {
	DEFAULT_CODING,
	DEFAULT_COMPACTION,
	DEFAULT_FETCH,
	DEFAULT_WEB_SEARCH,
	getSetting,
	type CodingSettings,
	type FetchSettings,
	type WebSearchSettings
} from '$lib/server/settings';
import { completeJob, createJob, failJob, pushChunk, type LiveJob } from '../jobs';
import { maybeCompact } from '../compaction';
import { buildContext } from '../context';
import { codingMaxSteps } from '../limits';
import { runAgentLoop, type LoopTool, type TurnSummary } from '../loop';
import { previousRunNote, runHistoryTool } from '../run-history';
import { webSearchConfigured, webSearchTool } from '../tools/web-search';
import { askUserTool } from '../ask-user';
import { attachmentTools } from '../tools/attachments';
import { boardTools } from '../tools/boards';
import { fetchUrlTool } from '../tools/fetch-url';
import { bootstrapContext, knowledgeTools } from '../tools/knowledge';
import { mcpLoopTools } from '../tools/mcp';
import { applyToolPolicy } from '../tools/registry';
import { getExecutor } from './executor';
import { captureState, clearState, formatState, isDirty, loadState } from './state';
import { codingTools } from './tools';
import { createWorkspace, destroyWorkspace, scrubSecrets, shellQuote } from './workspace';

export type CodeSession = typeof codeSessions.$inferSelect;

export function getSession(chatId: string, userId: string): CodeSession | null {
	const row = db.select().from(codeSessions).where(eq(codeSessions.chatId, chatId)).get();
	return row && row.userId === userId ? row : null;
}

export async function createSession(opts: {
	userId: string;
	repoUrl: string;
	repoName: string;
	mode: 'plan' | 'implement';
}): Promise<CodeSession> {
	const ws = await createWorkspace(opts.repoUrl);
	const chat = createChat({ userId: opts.userId, mode: 'code', title: opts.repoName });
	const row: CodeSession = {
		chatId: chat.id,
		userId: opts.userId,
		repoUrl: opts.repoUrl,
		repoName: opts.repoName,
		baseBranch: ws.baseBranch,
		workBranch: ws.workBranch,
		workspaceRel: ws.workspaceRel,
		mode: opts.mode,
		createdAt: new Date()
	};
	db.insert(codeSessions).values(row).run();
	return row;
}

export function setSessionMode(session: CodeSession, mode: 'plan' | 'implement'): void {
	db.update(codeSessions).set({ mode }).where(eq(codeSessions.chatId, session.chatId)).run();
}

export function destroySession(session: CodeSession): void {
	destroyWorkspace(session.workspaceRel);
	clearState(session.chatId);
	db.delete(codeSessions).where(eq(codeSessions.chatId, session.chatId)).run();
	deleteChat(session.chatId, session.userId);
}

/** Cumulative branch diff plus any uncommitted changes. */
export async function sessionDiff(session: CodeSession): Promise<string> {
	const res = await getExecutor().exec(
		`git log --oneline ${session.baseBranch}..HEAD; echo '---'; git diff ${session.baseBranch}...HEAD; git diff`,
		{ cwdRel: session.workspaceRel, timeoutMs: 30_000 }
	);
	return scrubSecrets(res.stdout + res.stderr).slice(0, 400_000);
}

export function startCodingTurn(opts: {
	session: CodeSession;
	userId: string;
	content: string;
	attachments?: AttachmentRef[];
	modelId?: string;
	webSearch?: boolean;
}): LiveJob {
	const { session } = opts;
	const chat = getChat(session.chatId, opts.userId);
	if (!chat) throw new EngineError('Session chat not found');
	assertBudget(opts.userId, 'coding');

	const cfg = getTaskConfig('coding');
	const choice = pickModel(opts.modelId ?? cfg?.primaryModelId ?? null);
	if (!choice) throw new EngineError('No usable model — configure one in admin');
	if (!choice.model.supportsTools) {
		throw new EngineError(
			`${choice.model.displayName} does not support tool calling — pick a tool-capable model for coding`
		);
	}
	const backup = cfg?.backupModelId ? resolveModel(cfg.backupModelId) : null;

	appendMessage(chat.id, {
		role: 'user',
		content: opts.content,
		attachments: opts.attachments
	});
	// Remember the model for this session (see startChatTurn).
	updateChat(chat.id, { modelId: choice.model.id });
	const job = createJob({ chatId: chat.id, userId: opts.userId, task: 'coding', persist: true });

	const systemPrompt = buildCodingSystemPrompt(cfg?.systemPrompt ?? '', session);
	// Read once, before the first leg: it describes the run *before* this one,
	// and must not start describing this turn's own legs partway through.
	const priorRun = previousRunNote(chat.id);
	const searchCfg = getSetting<WebSearchSettings>('websearch', DEFAULT_WEB_SEARCH);
	// Built per turn, exactly as chat does it: the tool keeps a per-turn memo
	// and search budget in its closure.
	const searchTools: LoopTool[] =
		opts.webSearch && webSearchConfigured(searchCfg) ? [webSearchTool(searchCfg)] : [];
	const tools = applyToolPolicy(
		[
			...codingTools({
				workspaceRel: session.workspaceRel,
				mode: session.mode,
				repoUrl: session.repoUrl
			}),
			...knowledgeTools(opts.userId),
			...attachmentTools(chat.id),
			// Reading a linked spec, an upstream README or an API doc is safe in
			// plan mode as well as implement — it changes nothing in the repo.
			fetchUrlTool(getSetting<FetchSettings>('fetch', DEFAULT_FETCH)),
			runHistoryTool(chat.id),
			// A coding task often is a card; reading the board is how the agent
			// finds out what it was actually asked for.
			...boardTools(opts.userId),
			askUserTool(job),
			...searchTools,
			...mcpLoopTools('coding')
		],
		'coding'
	);

	/** One pass of the agent loop. Resolves with how it ended. */
	const runLeg = async (): Promise<{ summary: TurnSummary | null; messageId?: string }> => {
		let summary: TurnSummary | null = null;
		let messageId: string | undefined;
		await runAgentLoop({
			job,
			task: 'coding',
			userId: opts.userId,
			chatId: chat.id,
			persist: true,
			primary: choice,
			backup,
			tools,
			maxIterations: codingMaxSteps(),
			budgetBlocked: () => getBudgetStatus().blocked,
			// Legs share one job, so the driver below closes it once at the end.
			autoComplete: false,
			// Rebuilt per call: compaction moves compactedUpTo, and the session
			// state block changes as the agent works. Replaying everything
			// regardless is what let a long session grow without bound.
			buildMessages: (): ProviderMessage[] =>
				buildContext({
					systemPrompt: systemPrompt + formatState(loadState(chat.id)) + priorRun,
					chat: getChat(chat.id, opts.userId) ?? chat,
					history: getMessages(chat.id),
					supportsVision: choice.model.supportsVision
				}),
			onDone: (text, _usage, usedChoice, turnSummary) => {
				summary = turnSummary;
				const saved = appendMessage(chat.id, {
					role: 'assistant',
					content: text,
					modelKey: usedChoice.model.modelKey
				});
				messageId = saved.id;
				updateChat(chat.id, {});
				// Same deal as chat: compact after the reply so it never delays
				// streaming, and so the next leg starts from a bounded transcript.
				void (async () => {
					const fresh = getChat(chat.id, opts.userId);
					if (fresh) {
						await maybeCompact({
							chat: fresh,
							systemPrompt,
							choice: usedChoice,
							settings: getSetting('compaction', DEFAULT_COMPACTION)
						});
					}
				})();
				return saved.id;
			}
		});
		return { summary, messageId };
	};

	void driveCodingTurn({ job, chat: chat.id, session, runLeg }).catch((err) => {
		if (job.status === 'running') failJob(job, String(err));
	});
	return job;
}

/**
 * Run the turn to a finish: capture what happened, checkpoint work the model
 * left uncommitted, and start another leg when it simply ran out of steps.
 *
 * Before this the loop just stopped at the step cap — silently, mid-task, with
 * edits sitting uncommitted and nothing recorded, so the next turn re-read the
 * repository from scratch to work out where it was.
 */
async function driveCodingTurn(opts: {
	job: LiveJob;
	chat: string;
	session: CodeSession;
	runLeg: () => Promise<{ summary: TurnSummary | null; messageId?: string }>;
}): Promise<void> {
	const { job, session } = opts;
	const coding = getSetting<CodingSettings>('coding', DEFAULT_CODING);
	let lastMessageId: string | undefined;

	for (let leg = 1; ; leg++) {
		const { summary, messageId } = await opts.runLeg();
		lastMessageId = messageId ?? lastMessageId;
		// No summary means the loop failed and already failed the job.
		if (!summary) return;

		await captureState({
			chatId: opts.chat,
			workspaceRel: session.workspaceRel,
			baseBranch: session.baseBranch,
			toolCalls: summary.toolCalls
		});

		const dirty = await isDirty(session.workspaceRel);
		if (dirty && coding.autoCheckpoint) {
			const committed = await checkpoint(job, session, summary);
			if (committed) {
				// Refresh so the next leg sees a clean tree and the new commit.
				await captureState({
					chatId: opts.chat,
					workspaceRel: session.workspaceRel,
					baseBranch: session.baseBranch,
					toolCalls: []
				});
			}
		} else if (dirty) {
			pushChunk(job, {
				type: 'notice',
				text: 'Turn ended with uncommitted changes in the workspace.'
			});
		}

		const canContinue =
			coding.autoContinue &&
			summary.stopReason === 'exhausted' &&
			leg < coding.maxLegs &&
			!job.controller.signal.aborted &&
			!getBudgetStatus().blocked;

		if (!canContinue) {
			if (summary.stopReason === 'exhausted') {
				pushChunk(job, {
					type: 'notice',
					text: `Stopped after ${summary.steps} steps without finishing. Send "continue" to pick up from here.`
				});
			}
			break;
		}

		pushChunk(job, {
			type: 'notice',
			text: `Step limit reached — continuing automatically (leg ${leg + 1} of ${coding.maxLegs}).`
		});
		// A real message rather than a hidden nudge: the transcript should show
		// why another assistant turn follows.
		appendMessage(opts.chat, {
			role: 'user',
			content:
				'Continue from where you left off. Use the session state above rather than re-reading the repository, and commit and push once the task is done.'
		});
	}

	completeJob(job, lastMessageId);
}

/** Commit whatever the turn left behind. Local only — never pushes. */
async function checkpoint(
	job: LiveJob,
	session: CodeSession,
	summary: TurnSummary
): Promise<boolean> {
	const changed = [
		...new Set(
			summary.toolCalls
				.filter((c) => (c.name === 'write_file' || c.name === 'edit_file') && c.summary)
				.map((c) => c.summary as string)
		)
	];
	const what = changed.length ? changed.slice(0, 5).join(', ') : 'work in progress';
	const res = await getExecutor().exec(
		`git add -A && git commit -m ${shellQuote(`WIP checkpoint (auto): ${what}`)}`,
		{ cwdRel: session.workspaceRel, timeoutMs: 30_000 }
	);
	if (res.code !== 0) {
		pushChunk(job, {
			type: 'notice',
			text: `Could not checkpoint uncommitted work: ${scrubSecrets(res.stderr || res.stdout).slice(0, 200)}`
		});
		return false;
	}
	pushChunk(job, {
		type: 'notice',
		text: 'Checkpointed uncommitted work locally so it is not lost — not pushed.'
	});
	return true;
}

function buildCodingSystemPrompt(base: string, session: CodeSession): string {
	const modeNote =
		session.mode === 'plan'
			? `You are in PLAN mode: only read-only tools are available. Explore the repository and produce a concrete, numbered implementation plan as your final answer. Do NOT attempt changes — the user must approve the plan first.`
			: [
					`You are in IMPLEMENT mode: make the changes. Read before you write, keep diffs minimal, run relevant checks with bash when available, then commit with git_commit and push with git_push. Finish with a short summary of what changed.`,
					// Both of these target ways a turn used to end mid-task: running
					// out of steps holding uncommitted edits, and answering with a
					// description of an edit instead of making it.
					`Never end a turn with uncommitted changes — if you are running short, commit what you have before you stop.`,
					`Never describe an action you have not taken: if you say you are going to edit a file, call the tool in the same turn.`
				].join(' ');
	return [
		base,
		'',
		`Repository: ${session.repoName} (branch ${session.workBranch}, based on ${session.baseBranch}).`,
		modeNote,
		bootstrapContext(session.userId)
	].join('\n');
}
