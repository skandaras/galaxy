import { lt } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { events, usageLog, users } from '$lib/server/db/schema';
import {
	DEFAULT_MEMORY,
	DEFAULT_RETENTION,
	DEFAULT_UX_AUDIT,
	getSetting,
	type MemorySettings,
	type RetentionSettings,
	type UxAuditSettings
} from '$lib/server/settings';
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
 * Trim the two tables that grow without bound — one row per model call, tool
 * call and job, forever. Deliberately conservative on usage_log: it is what the
 * budget cap and the usage dashboard read, so its window is much longer than
 * the Observatory's. Either can be set to 0 to keep everything.
 */
export function prune(now = Date.now(), force = false): { events: number; usage: number } {
	if (!force && now < lastPrune + PRUNE_INTERVAL_MS) return { events: 0, usage: 0 };
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

	// No VACUUM: the file does not shrink, but SQLite reuses the freed pages for
	// subsequent inserts, so the database plateaus instead of growing forever —
	// and a full VACUUM takes an exclusive lock this process cannot afford.
	return { events: prunedEvents, usage: prunedUsage };
}
