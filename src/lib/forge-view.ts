import type {
	ForgeCheckResult,
	ForgeEpicState,
	ForgeSprintState,
	ForgeTaskState
} from '$lib/server/db/schema';

/**
 * What the Forge page works out before it draws anything.
 *
 * Here rather than in the component for the reason the whole `$lib/*.ts` shelf
 * exists: tests run in node with no DOM, so logic inside a `.svelte` file is
 * logic nothing can assert. The arithmetic below is small and every bit of it
 * is the sort that is quietly wrong — a percentage over a total that counts
 * blocked tasks twice, a gate whose failing check is third in the list.
 */

/** The wire shapes, as `/api/forge` and `/api/forge/[id]` send them. */
export interface GateView {
	id: string;
	scope: 'task' | 'sprint' | 'epic';
	attempt: number;
	baseline: boolean;
	passed: boolean;
	createdAt: number;
	results: ForgeCheckResult[] | null;
}
export interface TaskView {
	id: string;
	title: string;
	state: ForgeTaskState;
	attempts: number;
	position: number;
	sprintId: string;
	recordDocId?: string | null;
	noCheckReason?: string;
	gate?: GateView | null;
}
export interface SprintView {
	id: string;
	title: string;
	goal: string;
	state: ForgeSprintState;
	position: number;
	recordDocId?: string | null;
	tasks: TaskView[];
	gate?: GateView | null;
}

export interface Progress {
	total: number;
	done: number;
	blocked: number;
	running: number;
	/** 0–100, rounded. Blocked counts as settled but never as done. */
	percent: number;
}

/**
 * How far along a set of tasks is.
 *
 * `percent` is done over total and nothing else. Counting blocked tasks as
 * progress would let a sprint where nothing worked read as finished, and
 * leaving them out of `total` would make the bar jump backwards the moment one
 * parked.
 */
export function progress(tasks: TaskView[]): Progress {
	const count = (s: ForgeTaskState) => tasks.filter((t) => t.state === s).length;
	const done = count('done');
	return {
		total: tasks.length,
		done,
		blocked: count('blocked'),
		running: count('running') + count('gating'),
		percent: tasks.length ? Math.round((done / tasks.length) * 100) : 0
	};
}

/** The same arithmetic over a whole tree, which is every sprint's tasks at once. */
export function epicProgress(sprints: SprintView[]): Progress {
	return progress(sprints.flatMap((s) => s.tasks));
}

/**
 * A sprint's tasks in the order they are meant to run.
 *
 * Position is the dependency — task N+1 cannot start until N is done — so it is
 * also the only order that reads correctly, whatever order the API sent.
 */
export function tasksOf(sprint: SprintView): TaskView[] {
	return [...sprint.tasks].sort((a, b) => a.position - b.position);
}

export function sprintsInOrder(sprints: SprintView[]): SprintView[] {
	return [...sprints]
		.sort((a, b) => a.position - b.position)
		.map((s) => ({ ...s, tasks: tasksOf(s) }));
}

/**
 * The checks of a gate run, failures first.
 *
 * A blocked unit is only ever opened to find out which check failed, so putting
 * that check third behind two green ones is making somebody read past the
 * answer. Within each group the original order is kept — that is the order the
 * gate ran them in, and it is what the output reads as.
 */
export function checksInReadingOrder(gate: GateView | null | undefined): ForgeCheckResult[] {
	if (!gate?.results) return [];
	const failed = gate.results.filter((r) => r.exitCode !== 0);
	return [...failed, ...gate.results.filter((r) => r.exitCode === 0)];
}

/** "2 of 3 checks passed", or what went wrong instead. */
export function gateSummary(gate: GateView | null | undefined): string {
	if (!gate) return 'no gate has run yet';
	const results = gate.results ?? [];
	if (!results.length) return gate.passed ? 'passed with no checks' : 'failed before any check ran';
	const passed = results.filter((r) => r.exitCode === 0).length;
	const timedOut = results.filter((r) => r.timedOut).length;
	const tail = timedOut ? `, ${timedOut} timed out` : '';
	return `${passed} of ${results.length} check${results.length === 1 ? '' : 's'} passed${tail}`;
}

/**
 * How long a check took, in something a person reads.
 *
 * Milliseconds are what the executor records and nobody thinks in. A gate that
 * says 184000ms is a gate somebody has to do arithmetic on.
 */
export function duration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return '';
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const secs = ms / 1000;
	if (secs < 60) return `${secs < 10 ? secs.toFixed(1) : Math.round(secs)}s`;
	const mins = Math.floor(secs / 60);
	return `${mins}m ${Math.round(secs % 60)}s`;
}

/**
 * Relative time, matching the bell's.
 *
 * Takes either shape on purpose. The bell is served `toWire`d rows carrying
 * epoch ms; Forge's routes hand back the rows themselves, so `json()` turns
 * every timestamp into an ISO string on the way out. Assuming one of those and
 * meeting the other is what produced "NaNd" in the bell.
 */
export function ago(ts: number | string | null | undefined, now = Date.now()): string {
	if (ts === null || ts === undefined) return '';
	const at = typeof ts === 'number' ? ts : Date.parse(String(ts));
	if (!Number.isFinite(at)) return '';
	const mins = Math.round((now - at) / 60_000);
	if (mins < 1) return 'just now';
	if (mins < 60) return `${mins}m ago`;
	const hrs = Math.round(mins / 60);
	return hrs < 24 ? `${hrs}h ago` : `${Math.round(hrs / 24)}d ago`;
}

/**
 * Whether an epic is waiting on a person rather than on the driver.
 *
 * The page's one real decision: `awaiting-approval` is the only state where
 * there is something to do, and it is the only state that gets a form.
 */
export const needsApproval = (state: ForgeEpicState): boolean => state === 'awaiting-approval';

/**
 * Three tones, because a badge with seven colours is a legend nobody reads.
 *
 * `warn` is "stopped and wants somebody", `good` is "finished or working", and
 * `idle` is everything that is simply waiting its turn.
 */
export type Tone = 'good' | 'warn' | 'idle';

export function epicTone(state: ForgeEpicState): Tone {
	if (state === 'blocked' || state === 'awaiting-approval') return 'warn';
	if (state === 'running' || state === 'done') return 'good';
	return 'idle';
}

export function taskTone(state: ForgeTaskState): Tone {
	if (state === 'blocked') return 'warn';
	if (state === 'done' || state === 'running' || state === 'gating') return 'good';
	return 'idle';
}

export function sprintTone(state: ForgeSprintState): Tone {
	if (state === 'blocked') return 'warn';
	if (state === 'done' || state === 'running' || state === 'gating') return 'good';
	return 'idle';
}

/** What a state is called out loud. Only where the stored word would mislead. */
const SAID: Partial<Record<ForgeEpicState | ForgeSprintState | ForgeTaskState, string>> = {
	'awaiting-approval': 'waiting for you',
	outlined: 'not planned yet',
	planning: 'being planned',
	gating: 'being checked',
	planned: 'queued'
};

export const say = (state: string): string => SAID[state as ForgeEpicState] ?? state;
