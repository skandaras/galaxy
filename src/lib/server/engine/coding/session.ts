import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { codeSessions, type AttachmentRef } from '$lib/server/db/schema';
import {
	appendMessage,
	createChat,
	deleteChat,
	getChat,
	getMessages,
	updateChat,
	updateMessage
} from '$lib/server/chats';
import { resolveModel } from '$lib/server/providers/registry';
import type { ProviderMessage } from '$lib/server/providers/types';
import { assertBudget, getBudgetStatus } from '../budget';
import { EngineError, getTaskConfig, pickModel } from '../engine';
import {
	DEFAULT_CODING,
	DEFAULT_COMPACTION,
	DEFAULT_FETCH,
	webSearchSettings,
	getSetting,
	type CodingSettings,
	type FetchSettings,
	type WebSearchSettings
} from '$lib/server/settings';
import { completeJob, createJob, failJob, pushChunk, type LiveJob } from '../jobs';
import { maybeCompact } from '../compaction';
import { buildContext } from '../context';
import { codingMaxSteps } from '../limits';
import {
	fallbackReply,
	runAgentLoop,
	type LoopTool,
	type StopReason,
	type TurnSummary
} from '../loop';
import { previousRunNote, runHistoryTool } from '../run-history';
import { summariseLeg, withDeadline } from '../run-summary';
import { webSearchConfigured, webSearchTool } from '../tools/web-search';
import { askUserTool } from '../ask-user';
import { attachmentTools } from '../tools/attachments';
import { boardTools } from '../tools/boards';
import { cortexTools } from '../tools/cortex';
import { learnFromReply } from '../cortex-learn';
import { fetchUrlTool } from '../tools/fetch-url';
import { bootstrapContext, knowledgeTools } from '../tools/knowledge';
import { mcpLoopTools } from '../tools/mcp';
import { applyToolPolicy } from '../tools/registry';
import { getExecutor } from './executor';
import { exploreTool } from './explore';
import {
	captureState,
	clearState,
	formatState,
	isDirty,
	loadState,
	setApprovedPlan
} from './state';
import { codingTools } from './tools';
import {
	createWorkspace,
	destroyWorkspace,
	repoInstructions,
	scrubSecrets,
	shellQuote
} from './workspace';

export type CodeSession = typeof codeSessions.$inferSelect;

/**
 * How long a checkpoint commit will wait for its leg summary. Short on
 * purpose: past this the commit takes the changed-file list it always used,
 * rather than a run staying open because a summariser is slow.
 */
const CHECKPOINT_SUMMARY_WAIT_MS = 6_000;

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
	// Leaving plan mode is the moment the plan becomes a commitment, so capture
	// it here rather than in the browser: it then holds however the mode was
	// switched, and survives the compaction that would otherwise summarise the
	// plan away halfway through building it.
	if (mode === 'implement' && session.mode === 'plan') {
		const lastReply = getMessages(session.chatId)
			.filter((m) => m.role === 'assistant' && m.content.trim())
			.at(-1);
		if (lastReply) setApprovedPlan(session.chatId, lastReply.content);
	}
	db.update(codeSessions).set({ mode }).where(eq(codeSessions.chatId, session.chatId)).run();
}

export function destroySession(session: CodeSession): void {
	destroyWorkspace(session.workspaceRel);
	clearState(session.chatId);
	db.delete(codeSessions).where(eq(codeSessions.chatId, session.chatId)).run();
	deleteChat(session.chatId, session.userId);
}

/** Total patch characters returned; past this the tail is dropped. */
const MAX_DIFF_CHARS = 400_000;

export interface SessionDiffFile {
	path: string;
	/** Null for a binary file, which git counts as `-`. */
	additions: number | null;
	deletions: number | null;
	patch: string;
}

export interface SessionDiff {
	/** `git log --oneline base..HEAD`. */
	commits: string;
	files: SessionDiffFile[];
	/** True when the patch was cut short, so the view can say so. */
	truncated: boolean;
}

/**
 * Everything this session has done to the repository, split per file.
 *
 * It used to be one string — log, branch diff and working diff concatenated,
 * capped at 400k and rendered as a single `<pre>`. Reviewing the diff is the
 * centre of the workflow, and a single scrolling block is where review stops
 * happening. The split happens here rather than in the browser so the shape is
 * testable without a DOM.
 *
 * The patch is the working tree against the base branch, which covers
 * committed and uncommitted work in one pass — the reviewer wants the state of
 * the branch, not an archaeology of how it got there. The commit list carries
 * that separately.
 */
export async function sessionDiff(session: CodeSession): Promise<SessionDiff> {
	const base = shellQuote(session.baseBranch);
	const res = await getExecutor().exec(
		`git log --oneline ${base}..HEAD; echo '${NUMSTAT_MARK}'; git diff --numstat ${base}; echo '${PATCH_MARK}'; git diff ${base}`,
		{ cwdRel: session.workspaceRel, timeoutMs: 30_000 }
	);
	const out = scrubSecrets(res.stdout);
	const [commits = '', rest = ''] = splitOnce(out, NUMSTAT_MARK);
	const [numstat = '', patch = ''] = splitOnce(rest, PATCH_MARK);

	const counts = new Map<string, { additions: number | null; deletions: number | null }>();
	for (const line of numstat.split('\n')) {
		const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line.trim());
		if (!m) continue;
		const n = (v: string) => (v === '-' ? null : Number(v));
		// A rename arrives as `old => new`; the new path is what to show.
		counts.set(renamedTo(m[3]), { additions: n(m[1]), deletions: n(m[2]) });
	}

	const truncated = patch.length > MAX_DIFF_CHARS;
	const files = splitPatch(truncated ? patch.slice(0, MAX_DIFF_CHARS) : patch).map((f) => ({
		...f,
		additions: counts.get(f.path)?.additions ?? null,
		deletions: counts.get(f.path)?.deletions ?? null
	}));
	return { commits: commits.trim(), files, truncated };
}

// Markers rather than a bare '---', which a diff can legitimately contain.
const NUMSTAT_MARK = '@@galaxy-numstat@@';
const PATCH_MARK = '@@galaxy-patch@@';

function splitOnce(text: string, mark: string): [string, string] {
	const at = text.indexOf(mark);
	return at === -1 ? [text, ''] : [text.slice(0, at), text.slice(at + mark.length)];
}

/** `dir/{old => new}.ts` and `old.ts => new.ts` both name the file it is now. */
function renamedTo(raw: string): string {
	const braced = /^(.*)\{.* => (.*)\}(.*)$/.exec(raw);
	if (braced) return `${braced[1]}${braced[2]}${braced[3]}`.replace(/\/\//g, '/');
	const plain = raw.split(' => ');
	return plain.length === 2 ? plain[1] : raw;
}

/** Cut a unified diff into one entry per file, keeping each file's header. */
export function splitPatch(patch: string): { path: string; patch: string }[] {
	const out: { path: string; patch: string }[] = [];
	let current: { path: string; patch: string } | null = null;
	for (const line of patch.split('\n')) {
		const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
		if (header) {
			if (current) out.push(current);
			current = { path: header[2], patch: line };
		} else if (current) {
			current.patch += `\n${line}`;
		}
	}
	if (current) out.push(current);
	return out;
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
	const searchCfg = webSearchSettings();
	/**
	 * Assembled per leg, not per turn.
	 *
	 * The search tool and fetch_url carry their per-turn memo and budget in a
	 * closure, so building them once and sharing them across an auto-continued
	 * turn meant leg 3 inherited a budget leg 1 had already spent — and a leg
	 * starts precisely because the model ran out of steps mid-task, which is
	 * when it most needs to look something up. Each leg is a fresh model turn
	 * and gets a fresh allowance; the tool says "leg" rather than "request" so
	 * the wording matches what the model actually has.
	 *
	 * Everything here is cheap to rebuild — DB reads and closures, no
	 * connections — and re-reading the tool policy each leg means an admin
	 * change takes effect at the next one rather than mid-turn.
	 */
	const buildTools = (): LoopTool[] =>
		applyToolPolicy(
			[
				...codingTools({
					chatId: chat.id,
					workspaceRel: session.workspaceRel,
					mode: session.mode,
					repoUrl: session.repoUrl,
					baseBranch: session.baseBranch,
					workBranch: session.workBranch
				}),
				// Reading the repository at arm's length: the sub-agent's own file
				// reads never enter this context, only its answer.
				exploreTool({
					workspaceRel: session.workspaceRel,
					mode: session.mode,
					repoUrl: session.repoUrl,
					baseBranch: session.baseBranch,
					workBranch: session.workBranch,
					parentJob: job,
					userId: opts.userId,
					chatId: chat.id
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
				// Why a thing is built the way it is outlives any one session, and
				// that is the sort of thing the lattice holds. The chat id is what
				// lets a query be judged against the reply it fed — see cortex-learn.
				...cortexTools(opts.userId, undefined, chat.id),
				askUserTool(job),
				...(opts.webSearch && webSearchConfigured(searchCfg)
					? [webSearchTool(searchCfg, { scope: 'leg' })]
					: []),
				...mcpLoopTools('coding')
			],
			'coding'
		);

	/** One pass of the agent loop. Resolves with how it ended. */
	const runLeg = async (): Promise<{ summary: TurnSummary | null; messageId?: string }> => {
		let summary: TurnSummary | null = null;
		let messageId: string | undefined;
		const tools = buildTools();
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
					systemPrompt,
					chat: getChat(chat.id, opts.userId) ?? chat,
					history: getMessages(chat.id),
					supportsVision: choice.model.supportsVision,
					// The two volatile blocks, kept out of the system message so the
					// prefix survives a leg. The state block changes every leg by design
					// — that is what it is for — and in front of the prompt it
					// invalidated everything behind it (see buildContext).
					tail: formatState(loadState(chat.id)) + priorRun
				}),
			onDone: (text, _usage, usedChoice, turnSummary) => {
				summary = turnSummary;
				const saved = appendMessage(chat.id, {
					role: 'assistant',
					content: text,
					modelKey: usedChoice.model.modelKey,
					// Kept with the reply so scrolled-back history still shows what
					// the agent did, not just what it said about it. The leg summary
					// heads it once it lands (see driveCodingTurn).
					trace: turnSummary.trace.length ? { steps: turnSummary.trace } : null
				});
				messageId = saved.id;
				updateChat(chat.id, {});
				// Which concepts the lattice offered this leg the reply went on to
				// use. A coding session is several legs, and each is judged on its
				// own: a query answered in leg one and leaned on in leg one is what
				// earns the strengthening.
				try {
					learnFromReply(chat.id, text);
				} catch {
					// Learning is a nicety. A leg must never fail because of it.
				}
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

	void driveCodingTurn({ job, chat: chat.id, session, userId: opts.userId, runLeg }).catch((err) => {
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
	userId: string;
	runLeg: () => Promise<{ summary: TurnSummary | null; messageId?: string }>;
}): Promise<void> {
	const { job, session } = opts;
	const coding = getSetting<CodingSettings>('coding', DEFAULT_CODING);
	let lastMessageId: string | undefined;
	// How the turn as a whole ended, which is how its last leg ended — several
	// legs can be exhausted on the way to one that finishes.
	let lastStopReason: StopReason | undefined;

	for (let leg = 1; ; leg++) {
		pushChunk(job, { type: 'stage', name: 'working', detail: `leg ${leg}` });
		const { summary, messageId } = await opts.runLeg();
		lastMessageId = messageId ?? lastMessageId;
		// No summary means the loop failed and already failed the job.
		if (!summary) return;
		lastStopReason = summary.stopReason;

		// Started here and deliberately not awaited: the git snapshot below is
		// several subprocess round-trips, which is free time for a cheap model.
		// One call per leg — never per tool call.
		const legSummary = summariseLeg({
			chatId: opts.chat,
			userId: opts.userId,
			persist: true,
			summary
		}).catch(() => null);

		// Fold the summary into the saved message once it lands: it heads the
		// collapsed step group in history, and it upgrades the stand-in reply a
		// cut-short leg saved — only ever the stand-in, never something the model
		// actually wrote.
		if (messageId) {
			const id = messageId;
			const leg = summary;
			void legSummary.then((note) => {
				if (!note) return;
				updateMessage(opts.chat, id, {
					...(leg.trace.length ? { trace: { summary: note, steps: leg.trace } } : {}),
					...(leg.fallbackReply ? { content: fallbackReply(leg.stopReason, note) } : {})
				});
			});
		}

		await captureState({
			chatId: opts.chat,
			workspaceRel: session.workspaceRel,
			baseBranch: session.baseBranch,
			toolCalls: summary.toolCalls
		});

		const dirty = await isDirty(session.workspaceRel);
		if (dirty && coding.autoCheckpoint) {
			pushChunk(job, { type: 'stage', name: 'checkpointing' });
			// The one place that waits on the summary at all, and only briefly:
			// the commit message wants it, and by now the model call has had the
			// git snapshot above to finish in. Past the deadline the commit falls
			// back to the changed-file list rather than holding the run open.
			const note = await withDeadline(legSummary, CHECKPOINT_SUMMARY_WAIT_MS);
			const committed = await checkpoint(job, session, summary, note);
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

		pushChunk(job, { type: 'stage', name: 'continuing', detail: `leg ${leg + 1}` });
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

	completeJob(job, lastMessageId, lastStopReason);
}

/**
 * Commit whatever the turn left behind. Local only — never pushes.
 *
 * `note` is the leg summary when one arrived in time. It replaces a commit
 * message that was a list of up to five paths — accurate, and no use at all
 * for working out later what the checkpoint was in the middle of.
 */
async function checkpoint(
	job: LiveJob,
	session: CodeSession,
	summary: TurnSummary,
	note: string | null
): Promise<boolean> {
	const changed = [
		...new Set(
			summary.toolCalls
				.filter((c) => (c.name === 'write_file' || c.name === 'edit_file') && c.summary)
				.map((c) => c.summary as string)
		)
	];
	const what = note || (changed.length ? changed.slice(0, 5).join(', ') : 'work in progress');
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
		bootstrapContext(session.userId),
		repoInstructions(session.workspaceRel)
	].join('\n');
}
