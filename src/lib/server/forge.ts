import { randomUUID } from 'node:crypto';
import { and, asc, eq, gte, like, or, sql, type SQL } from 'drizzle-orm';
import { db } from '$lib/server/db';
import {
	forgeEpics,
	forgeGateRuns,
	forgeSprints,
	forgeTasks,
	usageLog,
	type ForgeCheck,
	type ForgeCheckResult,
	type ForgeEpicState,
	type ForgeSprintState,
	type ForgeTaskState
} from '$lib/server/db/schema';
import { slugify } from '$lib/server/library';

/**
 * Forge's store: an epic, its sprints, their tasks, and every gate that has run.
 *
 * Ownership lives in the SQL predicate here, never in a route filtering what an
 * unscoped read handed back. An epic drives a coding agent against somebody's
 * repository, so "exists but not yours" has to be indistinguishable from "does
 * not exist" — every read below takes a userId for that reason and none of them
 * is optional.
 */

export type ForgeEpic = typeof forgeEpics.$inferSelect;
export type ForgeSprint = typeof forgeSprints.$inferSelect;
export type ForgeTask = typeof forgeTasks.$inferSelect;
export type ForgeGateRun = typeof forgeGateRuns.$inferSelect;

/** Everything `nextStep` needs, and nothing that would make it impure. */
export interface ForgeSnapshot {
	epic: ForgeEpic;
	sprints: ForgeSprint[];
	tasks: ForgeTask[];
}

const now = () => new Date();

export function createEpic(opts: {
	ownerId: string;
	title: string;
	brief?: string;
	repoUrl: string;
	repoName?: string;
	baseBranch?: string;
}): ForgeEpic {
	const id = randomUUID();
	const row = {
		id,
		ownerId: opts.ownerId,
		title: opts.title.trim() || 'Untitled epic',
		brief: opts.brief ?? '',
		repoUrl: opts.repoUrl,
		repoName: opts.repoName ?? '',
		baseBranch: opts.baseBranch || 'main',
		// Named after the epic rather than the id so a person looking at the
		// repository's branch list can tell which build it belongs to.
		integrationBranch: `forge/${slugify(opts.title)}-${id.slice(0, 8)}`,
		state: 'drafting' as ForgeEpicState,
		stateReason: '',
		charterDocId: null,
		boardId: null,
		standingChecks: null,
		gateChecks: null,
		acceptance: null,
		maxUsdOverride: 0,
		createdAt: now(),
		approvedAt: null,
		finishedAt: null,
		lastStepAt: null
	};
	db.insert(forgeEpics).values(row).run();
	return row;
}

export function getEpic(id: string, userId: string): ForgeEpic | null {
	return (
		db
			.select()
			.from(forgeEpics)
			.where(and(eq(forgeEpics.id, id), eq(forgeEpics.ownerId, userId)))
			.get() ?? null
	);
}

export function listEpics(userId: string): ForgeEpic[] {
	return db
		.select()
		.from(forgeEpics)
		.where(eq(forgeEpics.ownerId, userId))
		.orderBy(asc(forgeEpics.createdAt))
		.all();
}

/** Live epics the driver may advance, longest-waiting first. */
export function dueEpics(): ForgeEpic[] {
	return db
		.select()
		.from(forgeEpics)
		.where(eq(forgeEpics.state, 'running'))
		// Insertion order would starve whatever was created last as soon as there
		// is more work than the pace allows; the longest wait goes first instead.
		.orderBy(asc(forgeEpics.lastStepAt))
		.all();
}

export function setEpicState(
	id: string,
	state: ForgeEpicState,
	reason = ''
): void {
	db.update(forgeEpics)
		.set({
			state,
			stateReason: reason,
			...(state === 'done' || state === 'abandoned' ? { finishedAt: now() } : {})
		})
		.where(eq(forgeEpics.id, id))
		.run();
}

/**
 * Raise or drop what one epic may spend, overriding the instance ceiling.
 *
 * 0 inherits it, as `feed_topics.intervalHours` does — which is why this is the
 * one epic column a running build may see change under it. Nothing else here is
 * editable after approval, and deliberately so.
 */
export function setEpicOverride(id: string, maxUsdOverride: number): void {
	db.update(forgeEpics).set({ maxUsdOverride }).where(eq(forgeEpics.id, id)).run();
}

export function markStepped(id: string): void {
	db.update(forgeEpics).set({ lastStepAt: now() }).where(eq(forgeEpics.id, id)).run();
}

/**
 * Freeze the checks and let the epic start.
 *
 * The *only* writer of `standingChecks` and `gateChecks`, deliberately. A run
 * that could edit the commands its own work is judged by is a run marking its
 * own homework, and a repository that could name them is an untrusted input
 * choosing its own gate. Both are shut off by there being one door, here, taken
 * by a person once.
 */
export function approveEpic(
	id: string,
	userId: string,
	opts: { standingChecks: ForgeCheck[]; gateChecks?: ForgeCheck[]; acceptance?: string[] }
): ForgeEpic | null {
	const epic = getEpic(id, userId);
	if (!epic) return null;
	if (epic.approvedAt) return epic;
	db.update(forgeEpics)
		.set({
			standingChecks: opts.standingChecks,
			gateChecks: opts.gateChecks ?? [],
			acceptance: opts.acceptance ?? [],
			state: 'running',
			stateReason: '',
			approvedAt: now()
		})
		.where(eq(forgeEpics.id, id))
		.run();
	return getEpic(id, userId);
}

export function addSprint(opts: {
	epicId: string;
	title: string;
	goal?: string;
	position?: number;
}): ForgeSprint {
	const existing = listSprints(opts.epicId);
	const row = {
		id: randomUUID(),
		epicId: opts.epicId,
		position: opts.position ?? existing.length,
		title: opts.title,
		goal: opts.goal ?? '',
		state: 'outlined' as ForgeSprintState,
		recordDocId: null,
		attempts: 0,
		createdAt: now(),
		startedAt: null,
		finishedAt: null
	};
	db.insert(forgeSprints).values(row).run();
	return row;
}

/**
 * Throw away an epic's outline so a re-planned charter can write a fresh one.
 *
 * Only ever reachable before approval, where there are no tasks and nothing has
 * run — the charter is the one thing that can be asked for twice. After
 * approval the outline is what the driver is working through, and rewriting it
 * would be changing the plan underneath a build already following it.
 */
export function clearOutline(epicId: string): void {
	db.delete(forgeTasks).where(eq(forgeTasks.epicId, epicId)).run();
	db.delete(forgeSprints).where(eq(forgeSprints.epicId, epicId)).run();
}

export function listSprints(epicId: string): ForgeSprint[] {
	return db
		.select()
		.from(forgeSprints)
		.where(eq(forgeSprints.epicId, epicId))
		.orderBy(asc(forgeSprints.position))
		.all();
}

export function setSprintState(id: string, state: ForgeSprintState): void {
	db.update(forgeSprints)
		.set({
			state,
			...(state === 'running' ? { startedAt: now() } : {}),
			...(state === 'done' ? { finishedAt: now() } : {})
		})
		.where(eq(forgeSprints.id, id))
		.run();
}

/**
 * Open a task with its checks already frozen.
 *
 * Checks arrive here having been proved red against the tree as it stands — see
 * `baselineIsRed` in `engine/forge-gate.ts`. This function does not enforce
 * that, because the baseline run needs a workspace and this module never touches
 * one; what it does enforce is that a task opens with either checks or a stated
 * reason it has none.
 */
export function openTask(opts: {
	epicId: string;
	sprintId: string;
	title: string;
	intent?: string;
	acceptance?: string;
	checks?: ForgeCheck[];
	noCheckReason?: string;
	position?: number;
}): ForgeTask {
	const checks = opts.checks ?? [];
	const noCheckReason = opts.noCheckReason ?? '';
	if (!checks.length && !noCheckReason) {
		throw new Error('A task needs checks, or a stated reason it has none.');
	}
	const existing = listTasks(opts.epicId).filter((t) => t.sprintId === opts.sprintId);
	const row = {
		id: randomUUID(),
		epicId: opts.epicId,
		sprintId: opts.sprintId,
		position: opts.position ?? existing.length,
		title: opts.title,
		intent: opts.intent ?? '',
		acceptance: opts.acceptance ?? '',
		checks,
		noCheckReason,
		state: 'planned' as ForgeTaskState,
		attempts: 0,
		chatId: null,
		branch: '',
		recordDocId: null,
		cardId: null,
		createdAt: now(),
		startedAt: null,
		finishedAt: null
	};
	db.insert(forgeTasks).values(row).run();
	return row;
}

export function listTasks(epicId: string): ForgeTask[] {
	return db
		.select()
		.from(forgeTasks)
		.where(eq(forgeTasks.epicId, epicId))
		.orderBy(asc(forgeTasks.position))
		.all();
}

export function setTaskState(
	id: string,
	state: ForgeTaskState,
	patch: Partial<Pick<ForgeTask, 'chatId' | 'branch' | 'recordDocId' | 'cardId'>> = {}
): void {
	db.update(forgeTasks)
		.set({
			state,
			...patch,
			...(state === 'running' ? { startedAt: now() } : {}),
			...(state === 'done' ? { finishedAt: now() } : {})
		})
		.where(eq(forgeTasks.id, id))
		.run();
}

/** One task, scoped through its epic's owner. Never reachable across accounts. */
export function getTask(id: string, userId: string): ForgeTask | null {
	const row = db
		.select({ task: forgeTasks })
		.from(forgeTasks)
		.innerJoin(forgeEpics, eq(forgeEpics.id, forgeTasks.epicId))
		.where(and(eq(forgeTasks.id, id), eq(forgeEpics.ownerId, userId)))
		.get();
	return row?.task ?? null;
}

export type AmendResult =
	| { ok: true; task: ForgeTask }
	| { ok: false; reason: 'not-found' | 'not-blocked' | 'empty' };

/**
 * Give a parked task a different contract, and put it back in the queue.
 *
 * The one place a task's frozen checks may change, and only for a task that has
 * already stopped. The red-green rule exists to stop a *run* writing itself a
 * check it cannot fail; a person editing a task that ran out of attempts is the
 * case that rule was never about, and without this the only way out of a bad
 * check is to abandon the build. `couldNotRun` still applies at the route — a
 * person cannot freeze a sentence either.
 *
 * Attempts go back to nought deliberately. What parked was a task judged by a
 * different command, so counting its failures against this one would park the
 * new contract before it had been tried.
 */
export function amendTask(
	id: string,
	userId: string,
	opts: { checks?: ForgeCheck[]; noCheckReason?: string }
): AmendResult {
	const task = getTask(id, userId);
	if (!task) return { ok: false, reason: 'not-found' };
	if (task.state !== 'blocked') return { ok: false, reason: 'not-blocked' };
	const checks = opts.checks ?? [];
	const noCheckReason = opts.noCheckReason?.trim() ?? '';
	if (!checks.length && !noCheckReason) return { ok: false, reason: 'empty' };

	db.update(forgeTasks)
		.set({ checks, noCheckReason, attempts: 0, state: 'planned', finishedAt: null })
		.where(eq(forgeTasks.id, id))
		.run();
	return { ok: true, task: getTask(id, userId) as ForgeTask };
}

/** Count an attempt against a task. Parking is the caller's decision. */
export function countAttempt(id: string): number {
	const row = db.select().from(forgeTasks).where(eq(forgeTasks.id, id)).get();
	if (!row) return 0;
	const attempts = row.attempts + 1;
	db.update(forgeTasks).set({ attempts }).where(eq(forgeTasks.id, id)).run();
	return attempts;
}

/** Count an attempt against a sprint's gate. Parking is the caller's decision. */
export function countSprintAttempt(id: string): number {
	const row = db.select().from(forgeSprints).where(eq(forgeSprints.id, id)).get();
	if (!row) return 0;
	const attempts = row.attempts + 1;
	db.update(forgeSprints).set({ attempts }).where(eq(forgeSprints.id, id)).run();
	return attempts;
}

export function recordGateRun(opts: {
	epicId: string;
	scope: 'task' | 'sprint' | 'epic';
	targetId: string;
	attempt?: number;
	baseline?: boolean;
	results: ForgeCheckResult[];
	passed: boolean;
}): ForgeGateRun {
	const row = {
		id: randomUUID(),
		epicId: opts.epicId,
		scope: opts.scope,
		targetId: opts.targetId,
		attempt: opts.attempt ?? 1,
		baseline: opts.baseline ?? false,
		results: opts.results,
		passed: opts.passed,
		createdAt: now()
	};
	db.insert(forgeGateRuns).values(row).run();
	return row;
}

/** Gate runs against one unit, newest first. Never overwritten, so this is history. */
export function gateRunsFor(targetId: string, limit = 20): ForgeGateRun[] {
	return db
		.select()
		.from(forgeGateRuns)
		.where(eq(forgeGateRuns.targetId, targetId))
		.orderBy(sql`created_at DESC`)
		.limit(limit)
		.all();
}

/**
 * One gate run in full, or nothing.
 *
 * Joined to the epic rather than filtered after the fact, so a gate run
 * belonging to somebody else's build is indistinguishable from one that does
 * not exist — a gate's stored output is the repository's own test output, which
 * is the last thing to hand to a stranger who guessed an id.
 */
export function getGateRun(id: string, userId: string): ForgeGateRun | null {
	const row = db
		.select({ run: forgeGateRuns })
		.from(forgeGateRuns)
		.innerJoin(forgeEpics, eq(forgeEpics.id, forgeGateRuns.epicId))
		.where(and(eq(forgeGateRuns.id, id), eq(forgeEpics.ownerId, userId)))
		.get();
	return row?.run ?? null;
}

export function snapshot(epicId: string, userId: string): ForgeSnapshot | null {
	const epic = getEpic(epicId, userId);
	if (!epic) return null;
	return { epic, sprints: listSprints(epicId), tasks: listTasks(epicId) };
}

/**
 * What one epic has cost so far, in USD.
 *
 * Derived from `usage_log` rather than counted on the epic row, which is the
 * same choice `getBudgetStatus` makes and for the same reason: a counter drifts
 * the first time a write is missed, and then the number governing whether an
 * agent may keep spending money is one nobody can audit.
 *
 * Two joins, because an epic spends in two places. Every model call a task
 * makes runs in that task's chat. The charter, the sprint plans and the sprint
 * reviews are headless and have no chat at all, so `runHeadless` writes their
 * usage against a synthetic id carrying the epic — matching that prefix is what
 * stops the ceiling bounding only the coding half of the bill. An epic id is a
 * UUID, so the pattern brings no wildcard of its own.
 *
 * One thing it cannot see: deleting a coding chat nulls `usage_log.chat_id`
 * (see `chats.ts`), so a task's spend leaves this sum when its chat is purged.
 * The platform-wide cap still counts the money; only the attribution goes.
 */
export function forgeSpend(epicId: string): number {
	return sumCost(
		or(inTaskChatsOf(eq(forgeTasks.epicId, epicId)), like(usageLog.chatId, `forge#${epicId}#%`))
	);
}

/**
 * What every epic has cost since `sinceMs`, in USD — what `maxUsdPerDay` reads.
 *
 * A rolling window rather than a calendar day, unlike `getBudgetStatus`: the cap
 * it enforces is on an agent that runs for days unattended, and a calendar day
 * would let one reset at midnight and spend the same again before anybody was
 * awake to see it.
 */
export function forgeSpendSince(sinceMs: number): number {
	return sumCost(
		and(
			gte(usageLog.ts, new Date(sinceMs)),
			or(inTaskChatsOf(), like(usageLog.chatId, 'forge#%'))
		)
	);
}

/**
 * Usage rows belonging to Forge task chats, as a subquery rather than a list.
 *
 * Pulling the ids into JS first was fine for one epic — tens of tasks make a
 * short IN list — and not for the daily sum, which spans every epic the install
 * has ever run and would have grown an IN list without bound.
 */
function inTaskChatsOf(where?: SQL): SQL {
	const scope = where ? sql` AND ${where}` : sql``;
	return sql`${usageLog.chatId} IN (SELECT ${forgeTasks.chatId} FROM ${forgeTasks} WHERE ${forgeTasks.chatId} IS NOT NULL${scope})`;
}

function sumCost(where: SQL | undefined): number {
	const row = db
		.select({ total: sql<number | null>`SUM(${usageLog.costUsd})` })
		.from(usageLog)
		.where(where)
		.get();
	return row?.total ?? 0;
}

/**
 * Tasks of one epic with a coding job against them — what `concurrentTasks`
 * bounds, because `nextStep` deliberately does not.
 *
 * `gating` is not in flight. That task's job has ended; its gate is a step the
 * driver has still to run, and `nextStep` already puts it before anything else.
 * Counting it would stop an epic picking up the very work it is waiting on.
 */
export function tasksInFlight(epicId: string): number {
	const row = db
		.select({ n: sql<number>`COUNT(*)` })
		.from(forgeTasks)
		.where(and(eq(forgeTasks.epicId, epicId), eq(forgeTasks.state, 'running')))
		.get();
	return row?.n ?? 0;
}

/**
 * Live epics with work in flight — what `concurrentEpics` bounds.
 *
 * Joined against the epic's own state so a paused or abandoned epic holding a
 * stranded task does not spend one of the fronts. The boot reconcile clears
 * those, but it only runs at boot.
 */
export function epicsInFlight(): number {
	const row = db
		.select({ n: sql<number>`COUNT(DISTINCT ${forgeTasks.epicId})` })
		.from(forgeTasks)
		.innerJoin(forgeEpics, eq(forgeEpics.id, forgeTasks.epicId))
		.where(and(eq(forgeTasks.state, 'running'), eq(forgeEpics.state, 'running')))
		.get();
	return row?.n ?? 0;
}
