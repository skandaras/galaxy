import { deleteSetting, getSetting, setSetting } from '$lib/server/settings';
import type { ToolCallRecord } from '../loop';
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
	updatedAt: number;
}

export interface PlanItem {
	text: string;
	status: 'todo' | 'doing' | 'done';
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
	const previous = loadState(opts.chatId);
	const paths = (names: Set<string>) =>
		opts.toolCalls.filter((c) => names.has(c.name) && c.summary).map((c) => c.summary as string);

	const git = await gitSnapshot(opts.workspaceRel, opts.baseBranch);
	const state: CodingSessionState = {
		filesRead: merge(previous?.filesRead ?? [], paths(READ_TOOLS)),
		filesChanged: merge(previous?.filesChanged ?? [], paths(WRITE_TOOLS)),
		...git,
		// Carried forward explicitly: this is rebuilt from scratch every leg, and
		// anything not named here is silently dropped.
		...(previous?.approvedPlan ? { approvedPlan: previous.approvedPlan } : {}),
		...(previous?.plan?.length ? { plan: previous.plan } : {}),
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

/** Replace the working plan. The agent owns this list; it is not validated. */
export function setPlan(chatId: string, items: PlanItem[]): void {
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
			plan: items.slice(0, MAX_PLAN_ITEMS).map((i) => ({
				text: i.text.trim().slice(0, MAX_ITEM_CHARS),
				status: i.status
			})),
			updatedAt: Date.now()
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
): Promise<Pick<CodingSessionState, 'status' | 'commits' | 'diffStat'>> {
	const run = async (command: string) => {
		try {
			const res = await getExecutor().exec(command, { cwdRel: workspaceRel, timeoutMs: 20_000 });
			return scrubSecrets(res.stdout).trim().slice(0, MAX_GIT_CHARS);
		} catch {
			return '';
		}
	};
	const base = shellQuote(baseBranch);
	return {
		status: await run('git status --short'),
		commits: await run(`git log --oneline ${base}..HEAD`),
		diffStat: await run(`git diff --stat ${base}...HEAD`)
	};
}

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
	if (state.plan?.length) {
		lines.push(
			'',
			'[Working plan — your own checklist, kept across turns. Update it with update_plan as you finish each item, and add to it when you find work you had not accounted for.]',
			...state.plan.map(
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
