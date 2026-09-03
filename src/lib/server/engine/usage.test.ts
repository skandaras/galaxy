import { beforeAll, beforeEach, describe, it, expect } from 'vitest';
import { db, runMigrations } from '$lib/server/db';
import { usageLog } from '$lib/server/db/schema';
import { setSetting } from '$lib/server/settings';
import type { ModelChoice } from '$lib/server/providers/registry';
import { getBudgetStatus } from './budget';
import { costOf, logUsage } from './usage';

/** Enough of a ModelChoice to price a call; nothing here calls the adapter. */
const choiceAt = (prompt: number | null, completion: number | null) =>
	({
		model: {
			modelKey: 'test/model',
			promptCostPerMTok: prompt,
			completionCostPerMTok: completion
		}
	}) as unknown as ModelChoice;

describe('costOf', () => {
	it('prices prompt and completion tokens at the model’s list rates', () => {
		// 1M prompt @ $3 + 1M completion @ $15
		expect(costOf(choiceAt(3, 15).model, { promptTokens: 1_000_000, completionTokens: 1_000_000 }))
			.toBeCloseTo(18);
	});

	it('is null when the model carries no prices, rather than silently zero', () => {
		expect(costOf(choiceAt(null, null).model, { promptTokens: 1000, completionTokens: 1000 })).toBeNull();
		expect(costOf(choiceAt(3, null).model, { promptTokens: 1000, completionTokens: 1000 })).toBeNull();
	});

	it('is null with no usage at all', () => {
		expect(costOf(choiceAt(3, 15).model, null)).toBeNull();
	});

	it('subtracts what the gateway says caching saved', () => {
		const usage = { promptTokens: 1_000_000, completionTokens: 0, cacheDiscountUsd: 1 };
		expect(costOf(choiceAt(3, 15).model, usage)).toBeCloseTo(2);
	});

	it('never goes negative on the turn that writes the cache', () => {
		// A cache *write* costs more than plain input, so the discount arrives
		// negative — but a call can never be worth less than nothing.
		const usage = { promptTokens: 1_000, completionTokens: 0, cacheDiscountUsd: -5 };
		expect(costOf(choiceAt(3, 15).model, usage)).toBeGreaterThan(0);
	});
});

describe('logUsage', () => {
	beforeAll(() => runMigrations());
	beforeEach(() => {
		db.delete(usageLog).run();
		setSetting('budget', { enabled: true, limitUsd: 10, period: 'month' });
	});

	it('prices a background agent’s call, so the spend cap can see it', () => {
		// The regression this exists for: usage.ts hardcoded `costUsd: null`,
		// so every background agent — memory, ux-audit, alignment, cortex-groom,
		// sub-agents — spent real money that summed to $0 against the cap.
		logUsage({
			task: 'memory',
			choice: choiceAt(3, 15),
			usage: { promptTokens: 1_000_000, completionTokens: 1_000_000 },
			status: 'ok',
			userId: 'u1'
		});
		const row = db.select().from(usageLog).all()[0];
		expect(row.costUsd).toBeCloseTo(18);
		expect(row.modelKey).toBe('test/model');
		expect(getBudgetStatus().spentUsd).toBeCloseTo(18);
	});

	it('blocks once a background agent has spent past the cap', () => {
		for (let i = 0; i < 4; i++) {
			logUsage({
				task: 'cortex-groom',
				choice: choiceAt(3, 15),
				usage: { promptTokens: 1_000_000, completionTokens: 0 },
				status: 'ok',
				userId: 'u1'
			});
		}
		expect(getBudgetStatus().blocked).toBe(true);
	});

	it('records reasoning tokens, which the loop’s own logger used to drop', () => {
		logUsage({
			task: 'chat',
			choice: choiceAt(3, 15),
			usage: { promptTokens: 10, completionTokens: 500, reasoningTokens: 480 },
			status: 'ok',
			userId: 'u1'
		});
		expect(db.select().from(usageLog).all()[0].reasoningTokens).toBe(480);
	});

	it('keeps a hidden chat’s id out while still counting its spend', () => {
		logUsage({
			task: 'chat',
			choice: choiceAt(3, 15),
			usage: { promptTokens: 1_000_000, completionTokens: 0 },
			status: 'ok',
			userId: 'u1',
			chatId: null
		});
		const row = db.select().from(usageLog).all()[0];
		expect(row.chatId).toBeNull();
		expect(row.costUsd).toBeCloseTo(3);
	});

	it('still writes a row when no model was ever resolved', () => {
		logUsage({ task: 'chat', choice: null, modelKey: 'tried/this', usage: null, status: 'error' });
		const row = db.select().from(usageLog).all()[0];
		expect(row.modelKey).toBe('tried/this');
		expect(row.costUsd).toBeNull();
	});
});
