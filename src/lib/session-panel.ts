/**
 * What the coding page's session panel shows, and the logic behind it.
 *
 * Kept out of the component so it can be tested without a DOM, and so the
 * server's overview and the page agree on one shape: `coding/overview.ts`
 * imports the types from here rather than declaring its own copy.
 */
import type { TimelineItem } from './run-timeline';

export interface OverviewPlanItem {
	text: string;
	status: 'todo' | 'doing' | 'done';
}

export interface OverviewCheckRun {
	command: string;
	code: number | null;
	durationMs: number;
	error?: string;
}

export interface OverviewChecks {
	stage: 'pre_commit' | 'pre_push';
	runs: OverviewCheckRun[];
	error?: string;
	at: number;
}

export interface OverviewTotals {
	commits: number;
	files: number;
	insertions: number;
	deletions: number;
	uncommitted: number;
	at: number;
}

export interface SessionOverview {
	environment: {
		executor: 'local' | 'docker';
		repoName: string;
		/** A github.com link rebuilt from owner and repo; never the clone URL itself. */
		repoWebUrl: string | null;
		baseBranch: string;
		workBranch: string;
	};
	/** The latest coding model call that reported usage, or null before there is one. */
	context: {
		usedTokens: number;
		/** Null when the model row cannot be told apart, rather than a guess. */
		contextWindow: number | null;
		modelKey: string;
		at: number;
	} | null;
	connectors: { name: string; tools: number }[];
	goal: string | null;
	plan: OverviewPlanItem[];
	filesChanged: string[];
	changes: {
		totals: OverviewTotals | null;
		/** `git log --oneline` lines, possibly fewer than totals.commits. */
		commits: string[];
		prUrl: string | null;
	};
	checks: OverviewChecks[];
}

/** A sub-agent the run has out, as the stream reports it. */
export interface AgentRow {
	id: string;
	kind: string;
	label: string;
	status: 'running' | 'ok' | 'error';
	detail?: string;
	startedAt: number;
}

/** "just now", "4m ago", "3h ago", "2d ago": for figures that are a snapshot. */
export function formatAgo(at: number, now: number): string {
	const minutes = Math.floor(Math.max(0, now - at) / 60_000);
	if (minutes < 1) return 'just now';
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

/**
 * "1m 12s", rolling to "1h 04m": always two segments, so the column keeps its
 * width and a row does not shuffle sideways once a second.
 */
export function formatElapsed(from: number, now: number): string {
	const total = Math.max(0, Math.round((now - from) / 1000));
	if (total < 3600) {
		return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, '0')}s`;
	}
	const hours = Math.floor(total / 3600);
	return `${hours}h ${String(Math.floor((total % 3600) / 60)).padStart(2, '0')}m`;
}

/**
 * Past this share of the window the meter turns to the warning colour. The
 * engine starts folding history at 70% between turns, so a call above 80% is a
 * leg running close to the edge rather than a transcript about to be tidied.
 */
export const CONTEXT_HIGH_PERCENT = 80;

export function contextShare(
	used: number,
	window: number | null
): { percent: number | null; high: boolean } {
	if (!window || window <= 0) return { percent: null, high: false };
	const percent = Math.min(100, Math.round((used / window) * 100));
	return { percent, high: percent >= CONTEXT_HIGH_PERCENT };
}

const WRITE_TOOLS = new Set(['write_file', 'edit_file']);

/**
 * Files the agent has written, stored ones first, then any the run in flight
 * has written since. Only successful calls count: a failed tool's detail is
 * its error message, not a path.
 */
export function mergeOutputs(stored: string[], timeline: TimelineItem[]): string[] {
	const live = timeline.flatMap((item) =>
		item.kind === 'step'
			? item.tools
					.filter((t) => WRITE_TOOLS.has(t.name) && t.status === 'ok' && t.detail)
					.map((t) => t.detail as string)
			: []
	);
	return [...new Set([...stored, ...live])];
}

export function prNumber(url: string | null): number | null {
	const m = url ? /\/pull\/(\d+)/.exec(url) : null;
	return m ? Number(m[1]) : null;
}

export function planProgress(items: OverviewPlanItem[]): string {
	return `${items.filter((i) => i.status === 'done').length}/${items.length}`;
}

/** Tools whose finishing changes something the panel shows. */
const OVERVIEW_TOOLS = new Set(['update_plan', 'git_commit', 'git_push', 'open_pull_request']);

/**
 * Whether a stream chunk means the overview is out of date. A settled step is
 * a model call that has been logged, which moves the context figure.
 */
export function refreshesOverview(chunk: { type?: string; name?: string; status?: string }): boolean {
	if (chunk.status !== 'ok' && chunk.status !== 'error') return false;
	if (chunk.type === 'step') return true;
	return chunk.type === 'tool' && OVERVIEW_TOOLS.has(chunk.name ?? '');
}
