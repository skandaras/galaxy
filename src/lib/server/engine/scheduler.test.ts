import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { db, runMigrations } from '$lib/server/db';
import { events, usageLog } from '$lib/server/db/schema';
import { setSetting } from '$lib/server/settings';
import { prune } from './scheduler';

const NOW = Date.UTC(2026, 6, 31, 12, 0);
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000);

beforeAll(() => {
	runMigrations();
});

beforeEach(() => {
	db.delete(events).run();
	db.delete(usageLog).run();
	setSetting('retention', { eventDays: 60, usageDays: 400 });
});

const event = (ts: Date) =>
	db
		.insert(events)
		.values({
			id: randomUUID(),
			ts,
			type: 'model.call',
			name: 'chat',
			status: 'ok'
		})
		.run();

const usage = (ts: Date) =>
	db
		.insert(usageLog)
		.values({
			id: randomUUID(),
			ts,
			task: 'chat',
			modelKey: 'm',
			promptTokens: 1,
			completionTokens: 1,
			costUsd: 0.01,
			status: 'ok'
		})
		.run();

const counts = () => ({
	events: db.select().from(events).all().length,
	usage: db.select().from(usageLog).all().length
});

describe('prune', () => {
	it('drops history past the window and keeps everything inside it', () => {
		event(daysAgo(1));
		event(daysAgo(59));
		event(daysAgo(61));
		event(daysAgo(400));
		usage(daysAgo(1));
		usage(daysAgo(401));

		expect(prune(NOW, true)).toEqual({ events: 2, usage: 1 });
		expect(counts()).toEqual({ events: 2, usage: 1 });
	});

	it('keeps usage far longer than events, so the budget cap and charts survive', () => {
		// A year of usage is still inside the default usage window but well past
		// the Observatory's — trimming both to the same window would silently
		// empty the usage dashboard's longest view.
		event(daysAgo(365));
		usage(daysAgo(365));

		prune(NOW, true);
		expect(counts()).toEqual({ events: 0, usage: 1 });
	});

	it('keeps everything when a window is set to 0', () => {
		setSetting('retention', { eventDays: 0, usageDays: 0 });
		event(daysAgo(5000));
		usage(daysAgo(5000));

		expect(prune(NOW, true)).toEqual({ events: 0, usage: 0 });
		expect(counts()).toEqual({ events: 1, usage: 1 });
	});

	it('does not re-run on every tick', () => {
		event(daysAgo(400));
		prune(NOW, true);
		event(daysAgo(400));
		// Same tick window, so this one is skipped and the stale row survives.
		expect(prune(NOW + 60_000)).toEqual({ events: 0, usage: 0 });
		expect(counts().events).toBe(1);
		// Past the interval it runs again.
		expect(prune(NOW + 7 * 3_600_000).events).toBe(1);
	});
});
