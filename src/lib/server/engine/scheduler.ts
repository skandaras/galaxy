import { lt } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db';
import { events, usageLog, users, uxIdeas } from '$lib/server/db/schema';
import {
	ALIGNMENT_ENABLED_KEY,
	DEFAULT_ALIGNMENT,
	DEFAULT_MEMORY,
	DEFAULT_RETENTION,
	DEFAULT_UX_AUDIT,
	getSetting,
	type AlignmentSettings,
	type MemorySettings,
	type RetentionSettings,
	type UxAuditSettings
} from '$lib/server/settings';
import { refreshLayout } from '$lib/server/cortex';
import { getSynthesisStatus, runAlignmentSynthesis } from './alignment';
import { emitEvent } from './events';
import { getMemoryStatus, runMemory } from './memory';
import { runUxAudit } from './ux-audit';

const TICK_MS = 5 * 60 * 1000;
const UX_LAST_RUN_KEY = 'ux.lastRun';
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
		void tick();
	}, TICK_MS);
	timer.unref?.();
}

async function tick(): Promise<void> {
	// A slow sweep must not overlap the next tick.
	if (sweeping) return;
	sweeping = true;
	try {
		await sweepMemory();
		await sweepUxAudit();
		prune();
	} finally {
		sweeping = false;
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
		await runMemory('schedule', user.id).catch(() => {
			// runMemory reports its own failures via events
		});
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
		await runAlignmentSynthesis('schedule', user.id).catch(() => {
			// runAlignmentSynthesis reports its own failures via events
		});
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
	await runUxAudit('schedule').catch(() => {
		// runUxAudit reports its own failures via events
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
): { events: number; usage: number; uxIdeas: number } {
	const nothing = { events: 0, usage: 0, uxIdeas: 0 };
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

	// No VACUUM: the file does not shrink, but SQLite reuses the freed pages for
	// subsequent inserts, so the database plateaus instead of growing forever —
	// and a full VACUUM takes an exclusive lock this process cannot afford.
	return { events: prunedEvents, usage: prunedUsage, uxIdeas: prunedIdeas };
}
