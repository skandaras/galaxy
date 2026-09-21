import { lt } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db';
import { cortexChangeLog, events, jobs, usageLog, users, uxIdeas } from '$lib/server/db/schema';
import {
	ALIGNMENT_ENABLED_KEY,
	DEFAULT_ALIGNMENT,
	DEFAULT_MEMORY,
	DEFAULT_RETENTION,
	DEFAULT_SKILL_OPTIMISER,
	DEFAULT_UX_AUDIT,
	forgeSettings,
	getSetting,
	setSetting,
	type AlignmentSettings,
	type ForgeSettings,
	type MemorySettings,
	type RetentionSettings,
	type SkillOptimiserSettings,
	type UxAuditSettings
} from '$lib/server/settings';
import { decayReinforcement, refreshLayout } from '$lib/server/cortex';
import {
	dueEpics,
	epicsInFlight,
	forgeSpend,
	forgeSpendSince,
	setEpicState,
	tasksInFlight,
	type ForgeEpic
} from '$lib/server/forge';
import { notify } from '$lib/server/notifications';
import { groomSettings, groomStatus, runCortexGroom } from './cortex-groom';
import { getSynthesisStatus, runAlignmentSynthesis } from './alignment';
import { getBudgetStatus } from './budget';
import { emitEvent } from './events';
import { runStep } from './forge-run';
import { getMemoryStatus, runMemory, runSkillOptimiser } from './memory';
import { runUxAudit } from './ux-audit';

const TICK_MS = 5 * 60 * 1000;
const UX_LAST_RUN_KEY = 'ux.lastRun';
const SKILLS_LAST_RUN_KEY = 'skills.lastRun';
const FORGE_LAST_SKIP_KEY = 'forge.lastSkip';
/** A capped sweep files one event an hour, not one every five minutes. */
const FORGE_SKIP_GAP_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** Pruning is cheap but pointless to repeat every tick. */
const PRUNE_INTERVAL_MS = 6 * 3_600_000;

let started = false;
let sweeping = false;
let lastPrune = 0;

/**
 * Lightweight interval scheduler for the background jobs. Frequencies are
 * global settings (admin-editable) checked on every tick, so changes apply
 * without a restart.
 */
export function startScheduler(): void {
	if (started) return;
	started = true;
	const timer = setInterval(() => {
		// `tick` has a finally but no catch, and prune() deletes outside any
		// guard — so a throw here used to be an unhandled rejection on a timer,
		// which is the process. A failed sweep must cost one tick, not the server.
		tick().catch((err) => console.error('[scheduler] tick failed:', err));
	}, TICK_MS);
	timer.unref?.();
}

/**
 * One pass over every scheduled job.
 *
 * **Every sweep defined in this file belongs in this list.** Three of them were
 * not: the layout refresh, the Cortex groomer and the alignment letter were each
 * written, tested on their own and never called from here, so on every install
 * ever run they were dead code that looked shipped. Nothing caught it —
 * `noUnusedLocals` is off, so a sweep nobody calls type-checks perfectly — which
 * is why `scheduler.test.ts` now asserts this function reaches each one.
 *
 * Ordered cheapest first: the two synchronous Cortex sweeps answer "has anything
 * changed" without doing any work on most ticks, and the per-user model jobs run
 * sequentially after them so they cannot race the budget cap. Forge is last
 * because it is the most expensive thing here — one of its steps can be a gate
 * running the repository's whole test suite — and a sweep that overruns the
 * five-minute tick should overrun nobody else's turn.
 */
export async function tick(): Promise<void> {
	// A slow sweep must not overlap the next tick.
	if (sweeping) return;
	sweeping = true;
	try {
		sweepCortexLayout();
		sweepCortexLearning();
		await sweepMemory();
		await sweepCortexGroom();
		await sweepAlignmentSynthesis();
		await sweepUxAudit();
		await sweepSkillOptimiser();
		await sweepForge();
		prune();
	} finally {
		sweeping = false;
	}
}

/**
 * Run one scheduled agent, and make sure a failure leaves a trace somewhere.
 *
 * All four sweeps used to swallow with an empty catch, each carrying a comment
 * saying the agent "reports its own failures via events". That is true of what
 * happens inside the agent's own try block — every one of them catches, emits
 * and returns rather than rethrowing, so nothing reaching here has been
 * reported. It is not true of the work before it: `gatherActivity()`, a
 * settings read, the working/dismissed queries in memory.ts, `tidy()` and
 * `detect()` in cortex-groom.ts all run outside that block.
 *
 * A throw there reached neither the Observatory nor stdout — `tick`'s own
 * console.error never saw it either, because the empty catch had already eaten
 * it — so the agent simply went dark for a whole interval. For the UX audit
 * that is a week of nothing, with no way to find out why.
 *
 * Exported for tests.
 */
export async function runSweep(
	task: string,
	userId: string | undefined,
	run: () => Promise<unknown>
): Promise<void> {
	try {
		await run();
	} catch (err) {
		emitEvent({
			userId,
			task,
			type: 'job',
			name: `${task}.sweep`,
			status: 'error',
			detail: { reason: String(err), note: 'failed before the agent could report it' }
		});
		console.error(`[scheduler] ${task} failed before it could report:`, err);
	}
}

/** Each user has their own last-run and can opt out individually. */
async function sweepMemory(): Promise<void> {
	const cfg = getSetting<MemorySettings>('memory', DEFAULT_MEMORY);
	if (!cfg.enabled) return;
	const now = Date.now();
	for (const user of db.select().from(users).all()) {
		const status = getMemoryStatus(user.id);
		if (!status.enabled) continue;
		if (now < status.lastRun + cfg.intervalHours * 3_600_000) continue;
		// Sequential on purpose: parallel audits would race the budget cap
		// and hammer the provider. One user's failure must not stop the rest.
		await runSweep('memory', user.id, () => runMemory('schedule', user.id));
	}
}

/**
 * The lattice's gardener, per user and only for those who turned it on.
 *
 * Off by default: it files suggestions about the shape of somebody's own
 * concepts, which is not a thing to start doing unasked.
 */
async function sweepCortexGroom(): Promise<void> {
	const cfg = groomSettings();
	if (!cfg.enabled) return;
	const now = Date.now();
	for (const user of db.select().from(users).all()) {
		const status = groomStatus(user.id);
		if (!status.enabled) continue;
		if (now < status.lastRun + cfg.intervalHours * 3_600_000) continue;
		// Sequential, like the memory sweep: parallel runs would race the budget
		// cap, and one person's failure must not stop the rest.
		await runSweep('cortex-groom', user.id, () => runCortexGroom('schedule', user.id));
	}
}

/**
 * Keep the lattice map's coordinates current.
 *
 * Cheap on almost every tick: the signature check answers "has the graph
 * changed" without laying anything out, and usually it has not. Doing this here
 * rather than per request is what keeps the map free to open — force layout is
 * the expensive part of any graph view, and on demand it would be paid by
 * whoever opened the page.
 */
function sweepCortexLayout(): void {
	try {
		const res = refreshLayout();
		if (!res.recomputed) return;
		emitEvent({
			type: 'job',
			name: 'cortex.layout',
			status: 'ok',
			// Counts only. Node names never reach an event detail.
			detail: { nodes: res.nodes, edges: res.edges }
		});
	} catch (err) {
		// A layout that throws must not take the rest of the sweep with it.
		emitEvent({
			type: 'job',
			name: 'cortex.layout',
			status: 'error',
			detail: { error: err instanceof Error ? err.message : String(err) }
		});
	}
}

/**
 * Let unused connections erode.
 *
 * Global rather than per user: it is one arithmetic pass over the whole edge
 * table, and it decays by elapsed time rather than by tick, so running it on
 * every five-minute tick and running it once a day come to the same answer. That
 * is what makes it safe to sit here beside the layout check — a server that was
 * off for a week decays once by a week rather than catching up in a burst.
 */
function sweepCortexLearning(): void {
	try {
		const res = decayReinforcement();
		if (!res.edges) return;
		emitEvent({
			type: 'job',
			name: 'cortex.decay',
			status: 'ok',
			// Counts only, like every other Cortex event.
			detail: { edges: res.edges, days: Math.round(res.days * 100) / 100 }
		});
	} catch (err) {
		// Decay failing must not take the rest of the sweep with it.
		emitEvent({
			type: 'job',
			name: 'cortex.decay',
			status: 'error',
			detail: { error: err instanceof Error ? err.message : String(err) }
		});
	}
}

/**
 * The alignment letter, per user and only for those who turned the feature on.
 *
 * The letter is the only part of Alignment that ever runs unasked, and it reads
 * past assessments rather than journal entries — nothing here goes near an entry
 * nobody chose to have read.
 */
async function sweepAlignmentSynthesis(): Promise<void> {
	const cfg = getSetting<AlignmentSettings>('alignment', DEFAULT_ALIGNMENT);
	if (!cfg.enabled) return;
	const now = Date.now();
	for (const user of db.select().from(users).all()) {
		if (!getSetting<boolean>(ALIGNMENT_ENABLED_KEY, false, user.id)) continue;
		const { lastRun } = getSynthesisStatus(user.id);
		if (now < lastRun + cfg.synthesisIntervalHours * 3_600_000) continue;
		// Sequential for the same reason the memory sweep is, and one person's
		// failure must not stop the rest.
		await runSweep('alignment-synthesis', user.id, () =>
			runAlignmentSynthesis('schedule', user.id)
		);
	}
}

/**
 * The UX audit is global rather than per user: it reviews the platform itself
 * from aggregated telemetry and the interface source, not anyone's activity.
 */
async function sweepUxAudit(): Promise<void> {
	const cfg = getSetting<UxAuditSettings>('uxaudit', DEFAULT_UX_AUDIT);
	if (!cfg.enabled) return;
	const lastRun = getSetting<number>(UX_LAST_RUN_KEY, 0);
	if (Date.now() < lastRun + cfg.intervalHours * 3_600_000) return;
	await runSweep('ux-audit', undefined, () => runUxAudit('schedule'));
}

/**
 * Global like the UX audit above, because skills are platform-wide — and off
 * until somebody turns it on, unlike anything else in this file.
 *
 * `runSkillOptimiser` has been a complete background agent from the day it was
 * written and reachable only from the admin button, so it is the one agent that
 * ran exactly as often as a person remembered it existed. The default stays
 * `false` because switching it on starts a recurring model call that nothing
 * spends today, and skills change rarely enough that weekly is a decision rather
 * than an obvious default.
 *
 * Stamping the last-run key here rather than inside the agent: unlike the UX
 * audit there is no activity window to lose by advancing it on a failure, and
 * this way a broken run backs off for the interval instead of being retried on
 * every five-minute tick.
 */
async function sweepSkillOptimiser(): Promise<void> {
	const cfg = getSetting<SkillOptimiserSettings>('skillOptimiser', DEFAULT_SKILL_OPTIMISER);
	if (!cfg.enabled) return;
	const lastRun = getSetting<number>(SKILLS_LAST_RUN_KEY, 0);
	const now = Date.now();
	if (now < lastRun + cfg.intervalHours * 3_600_000) return;
	setSetting(SKILLS_LAST_RUN_KEY, now);
	await runSweep('skill-optimiser', undefined, () => runSkillOptimiser());
}

/**
 * Forge's driver — what makes an epic build itself rather than wait for
 * somebody to keep pressing a button.
 *
 * There is no process that "is" a running epic: `closeAbandonedJobs` ends
 * anything that tries to be one, and live job state is a module-level Map that
 * dies with the process. So an epic is a row whose state says what should
 * happen next, and this is the thing that notices. A restart mid-build loses at
 * most one step.
 *
 * Exported for its tests, as `prune` and `runSweep` are.
 */
export async function sweepForge(): Promise<void> {
	const cfg: ForgeSettings = forgeSettings();
	// 0 pauses everything, and because it is a settings row rather than a flag in
	// a process the pause survives a restart — which is the only kind of pause
	// worth having for something that runs for days.
	if (!cfg.enabled || cfg.stepsPerTick < 1) return;

	// The platform cap outranks Forge's own dials: an agent nobody is watching is
	// the last thing that should spend what is left of a capped month.
	if (getBudgetStatus().blocked) {
		noteForgeSkip('the budget cap is reached');
		return;
	}

	const dayCapReached = (): boolean => {
		if (cfg.maxUsdPerDay <= 0) return false;
		const today = forgeSpendSince(Date.now() - DAY_MS);
		if (today < cfg.maxUsdPerDay) return false;
		noteForgeSkip(`Forge has spent $${today.toFixed(2)} of its $${cfg.maxUsdPerDay} for the day`);
		return true;
	};

	let started = 0;
	// Longest-waiting first, which dueEpics orders for us. Insertion order would
	// starve whatever was created last as soon as there is more work than pace.
	for (const epic of dueEpics()) {
		if (started >= cfg.stepsPerTick) break;
		// Re-read per step rather than once for the tick: at twenty steps a tick
		// the first few can spend the day's allowance between them, and a ceiling
		// only checked at the top is one the rest of the tick sails past.
		if (dayCapReached()) break;

		const inFlight = tasksInFlight(epic.id);
		if (inFlight >= cfg.concurrentTasks) continue;
		// An epic with nothing in flight would be opening a new front, and
		// concurrentEpics is how many fronts there may be. Read fresh each time
		// round rather than counted up here: a step that just started a task has
		// already moved its epic into that count.
		if (inFlight === 0 && epicsInFlight() >= cfg.concurrentEpics) continue;

		// Between steps and never inside one. A step is the unit that produces
		// something usable, so stopping between them leaves a coherent tree rather
		// than a half-written file — research's rule, for research's reason.
		const ceiling = epic.maxUsdOverride || cfg.maxUsdPerEpic;
		if (ceiling > 0) {
			const spent = forgeSpend(epic.id);
			if (spent >= ceiling) {
				pauseOnSpend(epic, spent, ceiling);
				continue;
			}
		}

		let stepped = false;
		await runSweep('forge', epic.ownerId, async () => {
			const outcome = await runStep(epic, epic.ownerId);
			stepped = outcome.step !== 'none';
		});
		// An epic with nothing to do has not used the tick's allowance. Counting it
		// would let one idle epic at the head of the queue spend the whole tick and
		// leave the epic behind it never moving.
		if (stepped) started++;
	}
}

/**
 * Say why the driver did nothing, but not three hundred times a day.
 *
 * Skipping is never silent — every other sweep files its skips — and a budget
 * that stays capped for a week would otherwise file one event every five
 * minutes, which is the Observatory made useless by the thing it is reporting.
 * Same shape as the UX audit's.
 */
function noteForgeSkip(reason: string): void {
	const now = Date.now();
	if (now - getSetting<number>(FORGE_LAST_SKIP_KEY, 0) < FORGE_SKIP_GAP_MS) return;
	setSetting(FORGE_LAST_SKIP_KEY, now);
	emitEvent({
		task: 'forge',
		type: 'job',
		name: 'forge.sweep',
		status: 'error',
		detail: { skipped: true, reason }
	});
}

/**
 * Stop an epic that has spent what it was allowed to, and say so.
 *
 * `paused`, not `blocked`: nothing is wrong with the build, and raising the
 * ceiling is all it takes to carry on. Pausing is also what keeps this quiet —
 * a paused epic leaves dueEpics, so the bell rings once rather than on every
 * tick for ever, and notify() has no dedupe of its own to fall back on.
 */
function pauseOnSpend(epic: ForgeEpic, spent: number, ceiling: number): void {
	const reason = `it has spent $${spent.toFixed(2)} of its $${ceiling.toFixed(2)} ceiling`;
	setEpicState(epic.id, 'paused', reason);
	notify({
		userId: epic.ownerId,
		kind: 'forge-blocked',
		title: `"${epic.title}" has paused`,
		// No link until /forge exists: a notification pointing at a page that
		// answers 404 is worse than one that simply says what happened.
		body: `${reason}. Raise it to let the build carry on.`,
		entityId: epic.id
	});
	emitEvent({
		userId: epic.ownerId,
		task: 'forge',
		type: 'budget',
		name: 'forge.ceiling',
		status: 'error',
		detail: { epicId: epic.id, spentUsd: spent, ceilingUsd: ceiling }
	});
}

/**
 * Production keeps its UX decision history forever; see RetentionSettings.
 *
 * The process.env fallback is for tests, for the same reason db/index.ts has
 * one: SvelteKit snapshots the dynamic env when Vite loads its config, so it
 * cannot be varied per test.
 */
export function isProd(): boolean {
	return (env.GALAXY_ENV || process.env.GALAXY_ENV || 'dev') === 'prod';
}

/**
 * Trim the tables that grow without bound — one row per model call, tool call
 * and job, forever. Deliberately conservative on usage_log: it is what the
 * budget cap and the usage dashboard read, so its window is much longer than
 * the Observatory's. Any window can be set to 0 to keep everything.
 */
export function prune(
	now = Date.now(),
	force = false
): { events: number; jobs: number; usage: number; uxIdeas: number; cortexChanges: number } {
	const nothing = { events: 0, jobs: 0, usage: 0, uxIdeas: 0, cortexChanges: 0 };
	if (!force && now < lastPrune + PRUNE_INTERVAL_MS) return nothing;
	lastPrune = now;
	const cfg = getSetting<RetentionSettings>('retention', DEFAULT_RETENTION);

	let prunedEvents = 0;
	if (cfg.eventDays > 0) {
		prunedEvents = db
			.delete(events)
			.where(lt(events.ts, new Date(now - cfg.eventDays * 86_400_000)))
			.run().changes;
	}

	// Jobs ride the event window rather than carrying one of their own: a job row
	// is the header of an Observatory run, and once its events are gone there is
	// nothing left to open. This table had no ceiling at all — one row per turn,
	// kept forever — and was the only unbounded thing the pruner never touched.
	let prunedJobs = 0;
	if (cfg.eventDays > 0) {
		prunedJobs = db
			.delete(jobs)
			.where(lt(jobs.createdAt, new Date(now - cfg.eventDays * 86_400_000)))
			.run().changes;
	}

	let prunedUsage = 0;
	if (cfg.usageDays > 0) {
		prunedUsage = db
			.delete(usageLog)
			.where(lt(usageLog.ts, new Date(now - cfg.usageDays * 86_400_000)))
			.run().changes;
	}

	// Dev instances only. On prod this would throw away the record of what has
	// already been actioned or discarded, which is the only thing stopping the
	// audit proposing it all over again next week.
	let prunedIdeas = 0;
	if (!isProd() && cfg.uxIdeaDays > 0) {
		prunedIdeas = db
			.delete(uxIdeas)
			.where(lt(uxIdeas.createdAt, new Date(now - cfg.uxIdeaDays * 86_400_000)))
			.run().changes;
	}

	// Unlike the UX backlog, this prunes on prod too. Nothing here suppresses a
	// future suggestion — the change log is a record of what was done, read to
	// check the groomer's work and to undo it, and both of those happen within
	// days. A `before` snapshot is a whole node, so this is the fastest-growing
	// thing Cortex owns and the one place it needs a ceiling.
	let prunedCortex = 0;
	if (cfg.cortexChangeDays > 0) {
		prunedCortex = db
			.delete(cortexChangeLog)
			.where(lt(cortexChangeLog.createdAt, new Date(now - cfg.cortexChangeDays * 86_400_000)))
			.run().changes;
	}

	// No VACUUM: the file does not shrink, but SQLite reuses the freed pages for
	// subsequent inserts, so the database plateaus instead of growing forever —
	// and a full VACUUM takes an exclusive lock this process cannot afford.
	return {
		events: prunedEvents,
		jobs: prunedJobs,
		usage: prunedUsage,
		uxIdeas: prunedIdeas,
		cortexChanges: prunedCortex
	};
}
