import { deleteSetting, getSetting, setSetting } from '$lib/server/settings';
import type { ToolCallRecord } from '../loop';
import { getExecutor } from './executor';
import { scrubSecrets, shellQuote } from './workspace';

const KEY = 'coding-state';
/** Keep the carried-over block small — it is prepended to every later turn. */
const MAX_FILES = 40;
const MAX_GIT_CHARS = 2_000;

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
	updatedAt: number;
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
		updatedAt: Date.now()
	};
	setSetting(KEY, state, opts.chatId);
	return state;
}

export function loadState(chatId: string): CodingSessionState | null {
	return getSetting<CodingSessionState | null>(KEY, null, chatId);
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
	const lines: string[] = ['', '[Session state — carried over from your earlier turns]'];
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
