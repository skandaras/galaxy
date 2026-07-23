import { DEFAULT_MEMORY, getSetting, type MemorySettings } from '$lib/server/settings';
import { getMemoryStatus, runMemory } from './memory';

const TICK_MS = 5 * 60 * 1000;
let started = false;

/**
 * Lightweight interval scheduler for the memory job. The frequency is a
 * setting (admin-editable) checked on every tick, so changes apply without
 * a restart.
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
	const { lastRun } = getMemoryStatus();
	const due = lastRun + cfg.intervalHours * 3_600_000;
	if (Date.now() >= due) {
		await runMemory('schedule').catch(() => {
			// runMemory reports its own failures via events
		});
	}
}
