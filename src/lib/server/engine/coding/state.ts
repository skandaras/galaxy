import { deleteSetting, getSetting, setSetting } from '$lib/server/settings';
import type { ToolCallRecord } from '../loop';
import type { HookStage } from './hooks';
import { getExecutor } from './executor';
import { scrubSecrets, shellQuote } from './workspace';

const KEY = 'coding-state';
/** Keep the carried-over block small — it is prepended to every later turn. */
const MAX_FILES = 40;
const MAX_GIT_CHARS = 2_000;
/** A plan long enough to need more than this is not a plan any more. */
const MAX_PLAN_CHARS = 6_000;
/** Working-plan limits. A checklist longer than this is a different problem. */
const MAX_PLAN_ITEMS = 20;
const MAX_ITEM_CHARS = 120;
/** The goal is a label beside the session, not a second plan. */
const MAX_GOAL_CHARS = 80;
const MAX_CHECK_ERROR_CHARS = 200;

export interface CodingSessionState {
	/** Files the agent has already read, so it need not read them again blind. */
	filesRead: string[];
	/** Files it has written or edited. */
	filesChanged: string[];
	/** `git status --short` at the end of the last turn. */
	status: string;
	/** `git log --oneline <base>..HEAD`. */
	commits: string;
	/** `git diff --stat` against the base branch. */
	diffStat: string;
	/**
	 * The plan the user approved, kept here rather than left in the transcript.
	 *
	 * Approving a plan used to do two things: flip the session to implement mode
	 * and send "The plan is approved — implement it now." The plan itself stayed
	 * where it was written, as an ordinary assistant message — so a long build
	 * that crossed the compaction cutoff could have the plan summarised away
	 * underneath it and carry on implementing a paraphrase. The state block is
	 * outside the compacted transcript, which is exactly why it belongs here.
	 */
	approvedPlan?: string;
	/**
	 * The agent's own checklist for the work in front of it.
	 *
	 * Session state is carried *between* turns; nothing tracked progress
	 * *within* one, and a leg can run for fifty model steps (codingMaxSteps).
	 * Long runs drift — a step or two gets quietly skipped on the way to the
	 * thing that seemed most interesting. A list the agent maintains itself
	 * costs a couple of hundred tokens and gives it something to come back to.
	 */
	plan?: PlanItem[];
	/** What the work is for, in a few words, as the agent last put it in update_plan. */
	goal?: string;
	/**
	 * The latest run of each hook stage, for the session panel.
	 *
	 * The runs reached the Observatory as raw JSON on a tool event and nowhere
	 * else, so whether the gate had passed was a question for the event log.
	 */
	checks?: Partial<Record<HookStage, CheckResult>>;
	/**
	 * Counted at the end of the leg, beside the strings above. Those are cut to
	 * their first 2,000 characters for the prompt, which drops the summary line
	 * of a large diff stat, so they cannot be counted afterwards.
	 */
	totals?: ChangeTotals;
	updatedAt: number;
}

export interface PlanItem {
	text: string;
	status: 'todo' | 'doing' | 'done';
}

export interface CheckRun {
	command: string;
	/** Null when the command never produced an exit code, e.g. the runner failed. */
	code: number | null;
	durationMs: number;
	error?: string;
}

export interface CheckResult {
	runs: CheckRun[];
	/** Set when the stage failed before any command ran, e.g. an unreadable hooks file. */
	error?: string;
	at: number;
}

export interface ChangeTotals {
	commits: number;
	files: number;
	insertions: number;
	deletions: number;
	uncommitted: number;
	/** When they were counted: the end of the last leg, not the last tool call. */
	at: number;
}

/** Tool names whose `describe` yields a path worth remembering. */
const READ_TOOLS = new Set(['read_file']);
const WRITE_TOOLS = new Set(['write_file', 'edit_file']);

const merge = (previous: string[], added: string[]): string[] =>
	[...new Set([...previous, ...added])].slice(-MAX_FILES);

/**
 * Record what this turn did, so the next one starts knowing it.
 *
 * Tool exchanges are never persisted — they live only in the loop's local
 * message array — so without this a fresh turn has no idea which files it has
 * already read or what it changed, and re-reads the repository to find out.
 */
export async function captureState(opts: {
	chatId: string;
	workspaceRel: string;
	baseBranch: string;
	toolCalls: ToolCallRecord[];
}): Promise<CodingSessionState> {
	// A call that failed read or changed nothing, and the panel lists these as
	// the files the agent wrote.
	const paths = (names: Set<string>) =>
		opts.toolCalls
			.filter((c) => names.has(c.name) && c.status !== 'error' && c.summary)
			.map((c) => c.summary as string);

	const git = await gitSnapshot(opts.workspaceRel, opts.baseBranch);
	// Read after the git commands, not before them. Those take seconds, and a
	// write that landed in the meantime (the PR button recording its checks)
	// was overwritten by the copy this used to hold from before they started.
	const previous = loadState(opts.chatId);
	const state: CodingSessionState = {
		filesRead: merge(previous?.filesRead ?? [], paths(READ_TOOLS)),
		filesChanged: merge(previous?.filesChanged ?? [], paths(WRITE_TOOLS)),
		...git,
		// Carried forward explicitly: this is rebuilt from scratch every leg, and
		// anything not named here is silently dropped.
		...(previous?.approvedPlan ? { approvedPlan: previous.approvedPlan } : {}),
		...(previous?.plan?.length ? { plan: previous.plan } : {}),
		...(previous?.goal ? { goal: previous.goal } : {}),
		...(previous?.checks ? { checks: previous.checks } : {}),
		updatedAt: Date.now()
	};
	setSetting(KEY, state, opts.chatId);
	return state;
}

export function loadState(chatId: string): CodingSessionState | null {
	return getSetting<CodingSessionState | null>(KEY, null, chatId);
}

/**
 * Record the plan that was approved, so implementation has it whatever happens
 * to the transcript. Called when a session moves from plan mode to implement.
 */
export function setApprovedPlan(chatId: string, plan: string): void {
	const text = plan.trim();
	if (!text) return;
	const previous = loadState(chatId);
	setSetting(
		KEY,
		{
			filesRead: [],
			filesChanged: [],
			status: '',
			commits: '',
			diffStat: '',
			...previous,
			approvedPlan: text.slice(0, MAX_PLAN_CHARS),
			updatedAt: Date.now()
		} satisfies CodingSessionState,
		chatId
	);
}

/**
 * Replace the working plan. The agent owns this list; it is not validated.
 * A goal left out keeps the one already set: it changes far less often than
 * the list does.
 */
export function setPlan(chatId: string, items: PlanItem[], goal?: string): void {
	const previous = loadState(chatId);
	const nextGoal = goal?.trim().slice(0, MAX_GOAL_CHARS) || previous?.goal;
	setSetting(
		KEY,
		{
			filesRead: [],
			filesChanged: [],
			status: '',
			commits: '',
			diffStat: '',
			...previous,
			plan: items.slice(0, MAX_PLAN_ITEMS).map((i) => ({
				text: i.text.trim().slice(0, MAX_ITEM_CHARS),
				status: i.status
			})),
			...(nextGoal ? { goal: nextGoal } : {}),
			updatedAt: Date.now()
		} satisfies CodingSessionState,
		chatId
	);
}

/** Keep the latest run of one hook stage. Synchronous, so it cannot interleave a read and its write. */
export function recordChecks(chatId: string, stage: HookStage, result: Omit<CheckResult, 'at'>): void {
	const previous = loadState(chatId);
	setSetting(
		KEY,
		{
			filesRead: [],
			filesChanged: [],
			status: '',
			commits: '',
			diffStat: '',
			...previous,
			checks: {
				...previous?.checks,
				[stage]: {
					// The commands come from the repository's hooks file and are shown
					// in the browser, so they get the same scrub as anything else a
					// repository hands over.
					runs: result.runs.map((r) => ({
						command: scrubSecrets(r.command),
						code: r.code,
						durationMs: r.durationMs,
						...(r.error ? { error: scrubSecrets(r.error).slice(0, MAX_CHECK_ERROR_CHARS) } : {})
					})),
					...(result.error
						? { error: scrubSecrets(result.error).slice(0, MAX_CHECK_ERROR_CHARS) }
						: {}),
					at: Date.now()
				}
			},
			updatedAt: previous?.updatedAt ?? Date.now()
		} satisfies CodingSessionState,
		chatId
	);
}

export function clearState(chatId: string): void {
	deleteSetting(KEY, chatId);
}

async function gitSnapshot(
	workspaceRel: string,
	baseBranch: string
): Promise<Pick<CodingSessionState, 'status' | 'commits' | 'diffStat' | 'totals'>> {
	const run = async (command: string) => {
		try {
			const res = await getExecutor().exec(command, { cwdRel: workspaceRel, timeoutMs: 20_000 });
			return capLines(scrubSecrets(res.stdout).trim());
		} catch {
			return '';
		}
	};
	const base = shellQuote(baseBranch);
	const totals = await countChanges(workspaceRel, base);
	return {
		status: await run('git status --short'),
		commits: await run(`git log --oneline ${base}..HEAD`),
		diffStat: await run(`git diff --stat ${base}...HEAD`),
		...(totals ? { totals } : {})
	};
}

/**
 * Cut at the last whole line under the cap. A character cut left half a
 * commit subject at the end, which the panel then listed as a commit.
 */
export function capLines(text: string, max = MAX_GIT_CHARS): string {
	if (text.length <= max) return text;
	const cut = text.lastIndexOf('\n', max);
	return cut > 0 ? text.slice(0, cut) : text.slice(0, max);
}

const TOTALS_MARK = '@@galaxy-totals@@';

/**
 * One command for all the counts, since in docker mode every exec is a fresh
 * container. The diff is the working tree against the base, the comparison
 * View diff makes, so the panel and the diff agree on what changed.
 */
async function countChanges(workspaceRel: string, base: string): Promise<ChangeTotals | null> {
	try {
		const res = await getExecutor().exec(
			// Chained with && so a git failure fails the whole command: separated
			// by semicolons, a failed diff printed nothing and read as no changes.
			`git rev-list --count ${base}..HEAD && echo '${TOTALS_MARK}' && git diff --shortstat ${base} && echo '${TOTALS_MARK}' && git status --porcelain | wc -l`,
			{ cwdRel: workspaceRel, timeoutMs: 20_000 }
		);
		const totals = res.code === 0 ? parseTotals(res.stdout) : null;
		return totals ? { ...totals, at: Date.now() } : null;
	} catch {
		return null;
	}
}

/** Exported for tests. */
export function parseTotals(out: string): Omit<ChangeTotals, 'at'> | null {
	const parts = out.split(TOTALS_MARK).map((s) => s.trim());
	if (parts.length !== 3) return null;
	const [commits, shortstat, uncommitted] = parts;
	// Anything other than what git prints is unknown, not zero: a count of no
	// changes that was really a failed command is the one wrong answer here.
	const stat = SHORTSTAT.exec(shortstat);
	if (!/^\d+$/.test(commits) || !/^\d+$/.test(uncommitted) || (shortstat && !stat)) return null;
	return {
		commits: Number(commits),
		files: Number(stat?.[1] ?? 0),
		insertions: Number(stat?.[2] ?? 0),
		deletions: Number(stat?.[3] ?? 0),
		uncommitted: Number(uncommitted)
	};
}

const SHORTSTAT =
	/^(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?$/;

/** True when the working tree has changes that are not committed. */
export async function isDirty(workspaceRel: string): Promise<boolean> {
	try {
		const res = await getExecutor().exec('git status --porcelain', {
			cwdRel: workspaceRel,
			timeoutMs: 20_000
		});
		return res.stdout.trim().length > 0;
	} catch {
		return false;
	}
}

/**
 * The block handed to the next turn. Explicitly tells the model not to
 * re-derive what it already established — the whole point of carrying state.
 */
export function formatState(state: CodingSessionState | null): string {
	if (!state) return '';
	const lines: string[] = [];
	if (state.approvedPlan) {
		lines.push(
			'',
			'[Approved plan — this is what you are building. It was agreed before implementation started; follow it, and say so plainly if you need to depart from it.]',
			state.approvedPlan
		);
	}
	if (state.plan?.length || state.goal) {
		lines.push(
			'',
			'[Working plan — your own checklist, kept across turns. Update it with update_plan as you finish each item, and add to it when you find work you had not accounted for.]',
			...(state.goal ? [`Goal: ${state.goal}`] : []),
			...(state.plan ?? []).map(
				(i) => `${i.status === 'done' ? '[x]' : i.status === 'doing' ? '[~]' : '[ ]'} ${i.text}`
			)
		);
	}
	lines.push('', '[Session state — carried over from your earlier turns]');
	if (state.filesRead.length) lines.push(`Already read: ${state.filesRead.join(', ')}`);
	if (state.filesChanged.length) lines.push(`Already changed: ${state.filesChanged.join(', ')}`);
	if (state.commits) lines.push(`Commits on this branch so far:\n${state.commits}`);
	if (state.diffStat) lines.push(`Cumulative diff:\n${state.diffStat}`);
	lines.push(
		state.status
			? `Uncommitted changes right now:\n${state.status}`
			: 'Working tree is clean — everything so far is committed.'
	);
	lines.push(
		'Trust this rather than re-reading the repository to rediscover it. Re-read a file only when you need contents you have not already acted on.'
	);
	return lines.join('\n');
}
