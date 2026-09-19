import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
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
 * Every model call a task makes runs in that task's chat, so the epic's chats
 * are the join. Tens of tasks make a short IN list; an epic large enough for
 * that to matter has bigger problems.
 */
export function forgeSpend(epicId: string): number {
	const chatIds = db
		.select({ chatId: forgeTasks.chatId })
		.from(forgeTasks)
		.where(eq(forgeTasks.epicId, epicId))
		.all()
		.map((r) => r.chatId)
		.filter((id): id is string => !!id);
	if (!chatIds.length) return 0;
	const row = db
		.select({ total: sql<number | null>`SUM(${usageLog.costUsd})` })
		.from(usageLog)
		.where(inArray(usageLog.chatId, chatIds))
		.get();
	return row?.total ?? 0;
}
