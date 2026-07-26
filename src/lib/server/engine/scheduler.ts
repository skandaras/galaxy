import { db } from '$lib/server/db';
import { users } from '$lib/server/db/schema';
import { DEFAULT_MEMORY, getSetting, type MemorySettings } from '$lib/server/settings';
import { getMemoryStatus, runMemory } from './memory';

const TICK_MS = 5 * 60 * 1000;
let started = false;
let sweeping = false;

/**
 * Lightweight interval scheduler for the memory job. The frequency is a global
 * setting (admin-editable) checked on every tick, so changes apply without a
 * restart; each user has their own last-run and can opt out individually.
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
	const cfg = getSetting<MemorySettings>('memory', DEFAULT_MEMORY);
	if (!cfg.enabled) return;
	// A slow sweep must not overlap the next tick.
	if (sweeping) return;
	sweeping = true;
	try {
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
	} finally {
		sweeping = false;
	}
}
