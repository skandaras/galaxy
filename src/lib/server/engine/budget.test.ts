import { beforeAll, beforeEach, describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { db, runMigrations } from '$lib/server/db';
import { usageLog } from '$lib/server/db/schema';
import { setSetting } from '$lib/server/settings';
import { getBudgetStatus, periodStart } from './budget';

describe('periodStart', () => {
	// Wed 2026-07-22 15:30 local
	const now = new Date(2026, 6, 22, 15, 30);

	it('day → local midnight today', () => {
		expect(periodStart('day', now)).toEqual(new Date(2026, 6, 22));
	});

	it('week → Monday of the current ISO week', () => {
		expect(periodStart('week', now)).toEqual(new Date(2026, 6, 20));
		// A Sunday still belongs to the week started the previous Monday
		expect(periodStart('week', new Date(2026, 6, 26, 9, 0))).toEqual(new Date(2026, 6, 20));
		// A Monday starts its own week
		expect(periodStart('week', new Date(2026, 6, 20, 0, 5))).toEqual(new Date(2026, 6, 20));
	});

	it('month → the 1st', () => {
		expect(periodStart('month', now)).toEqual(new Date(2026, 6, 1));
	});
});

describe('getBudgetStatus', () => {
	beforeAll(() => {
		runMigrations();
	});

	const log = (costUsd: number | null, tokens = 100) =>
		db
			.insert(usageLog)
			.values({
				id: randomUUID(),
				ts: new Date(),
				userId: 'u1',
				chatId: 'c1',
				task: 'chat',
				modelKey: 'm',
				promptTokens: tokens,
				completionTokens: tokens,
				costUsd,
				status: 'ok'
			})
			.run();

	beforeEach(() => {
		db.delete(usageLog).run();
		setSetting('budget', { enabled: true, limitUsd: 10, period: 'day' });
	});

	it('sums spend across the instance, not per user', () => {
		log(1.5);
		db.insert(usageLog)
			.values({
				id: randomUUID(),
				ts: new Date(),
				userId: 'someone-else',
				chatId: 'c2',
				task: 'chat',
				modelKey: 'm',
				promptTokens: 10,
				completionTokens: 10,
				costUsd: 2.5,
				status: 'ok'
			})
			.run();
		expect(getBudgetStatus().spentUsd).toBeCloseTo(4);
	});

	it('blocks once spend reaches the cap', () => {
		log(10);
		expect(getBudgetStatus().blocked).toBe(true);
	});

	it('does not block when the cap is disabled', () => {
		setSetting('budget', { enabled: false, limitUsd: 10, period: 'day' });
		log(99);
		expect(getBudgetStatus().blocked).toBe(false);
	});

	it('reports unpriced calls so $0.00 is not read as idle', () => {
		// A model with no per-token pricing logs a null cost, so it contributes
		// nothing to spend even though it burned tokens.
		log(null);
		const status = getBudgetStatus();
		expect(status.spentUsd).toBe(0);
		expect(status.unpricedCalls).toBe(1);
	});

	it('does not count a failed call with no tokens as unpriced', () => {
		log(null, 0);
		expect(getBudgetStatus().unpricedCalls).toBe(0);
	});
});
