import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { codeSessions, type AttachmentRef } from '$lib/server/db/schema';
import { appendMessage, createChat, deleteChat, getChat, getMessages, updateChat } from '$lib/server/chats';
import { resolveModel } from '$lib/server/providers/registry';
import type { ProviderMessage } from '$lib/server/providers/types';
import { assertBudget } from '../budget';
import { EngineError, getTaskConfig, pickModel } from '../engine';
import { createJob, failJob, type LiveJob } from '../jobs';
import { messageContent } from '../context';
import { runAgentLoop } from '../loop';
import { attachmentTools } from '../tools/attachments';
import { bootstrapContext, knowledgeTools } from '../tools/knowledge';
import { getExecutor } from './executor';
import { codingTools } from './tools';
import { createWorkspace, destroyWorkspace, scrubSecrets } from './workspace';

const MAX_CODING_ITERATIONS = 24;

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
	const job = createJob({ chatId: chat.id, userId: opts.userId, task: 'coding', persist: true });

	const systemPrompt = buildCodingSystemPrompt(cfg?.systemPrompt ?? '', session);
	void runAgentLoop({
		job,
		task: 'coding',
		userId: opts.userId,
		chatId: chat.id,
		persist: true,
		primary: choice,
		backup,
		tools: [
			...codingTools({
				workspaceRel: session.workspaceRel,
				mode: session.mode,
				repoUrl: session.repoUrl
			}),
			...knowledgeTools(),
			...attachmentTools(chat.id)
		],
		maxIterations: MAX_CODING_ITERATIONS,
		buildMessages: (): ProviderMessage[] => [
			{ role: 'system', content: systemPrompt },
			...getMessages(chat.id)
				.filter((m) => m.role !== 'tool')
				.map(
					(m) =>
						({
							role: m.role,
							content: messageContent(m, choice.model.supportsVision)
						}) as ProviderMessage
				)
		],
		onDone: (text, _usage, usedChoice) => {
			const saved = appendMessage(chat.id, {
				role: 'assistant',
				content: text,
				modelKey: usedChoice.model.modelKey
			});
			updateChat(chat.id, {});
			return saved.id;
		}
	}).catch((err) => {
		if (job.status === 'running') failJob(job, String(err));
	});
	return job;
}

function buildCodingSystemPrompt(base: string, session: CodeSession): string {
	const modeNote =
		session.mode === 'plan'
			? `You are in PLAN mode: only read-only tools are available. Explore the repository and produce a concrete, numbered implementation plan as your final answer. Do NOT attempt changes — the user must approve the plan first.`
			: `You are in IMPLEMENT mode: make the changes. Read before you write, keep diffs minimal, run relevant checks with bash when available, then commit with git_commit and push with git_push. Finish with a short summary of what changed.`;
	return [
		base,
		'',
		`Repository: ${session.repoName} (branch ${session.workBranch}, based on ${session.baseBranch}).`,
		modeNote,
		bootstrapContext(session.userId)
	].join('\n');
}
