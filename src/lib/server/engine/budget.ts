import { sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { DEFAULT_BUDGET, getSetting, type BudgetSettings } from '$lib/server/settings';
import { emitEvent } from './events';

export interface BudgetStatus {
	enabled: boolean;
	limitUsd: number;
	period: BudgetSettings['period'];
	spentUsd: number;
	periodStart: number;
	blocked: boolean;
	/**
	 * Calls this period that burned tokens but contributed nothing to `spentUsd`,
	 * because their model has no per-token pricing configured. Without this a
	 * spend of $0.00 is indistinguishable from "nothing has run yet".
	 */
	unpricedCalls: number;
}

/** Calendar-period start in server-local time: today / this ISO week (Mon) / this month. */
export function periodStart(period: BudgetSettings['period'], now = new Date()): Date {
	const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	if (period === 'week') {
		const dow = (d.getDay() + 6) % 7; // Mon=0 … Sun=6
		d.setDate(d.getDate() - dow);
	} else if (period === 'month') {
		d.setDate(1);
	}
	return d;
}

export function getBudgetStatus(now = new Date()): BudgetStatus {
	const cfg = getSetting<BudgetSettings>('budget', DEFAULT_BUDGET);
	const start = periodStart(cfg.period, now).getTime();
	const row = db.get<{ spent: number; unpriced: number }>(
		sql`SELECT COALESCE(SUM(cost_usd),0) AS spent,
		           COUNT(CASE WHEN cost_usd IS NULL
		                       AND (prompt_tokens > 0 OR completion_tokens > 0)
		                      THEN 1 END) AS unpriced
		    FROM usage_log WHERE ts >= ${start}`
	);
	const spent = row?.spent ?? 0;
	return {
		enabled: cfg.enabled,
		limitUsd: cfg.limitUsd,
		period: cfg.period,
		spentUsd: spent,
		periodStart: start,
		blocked: cfg.enabled && spent >= cfg.limitUsd,
		unpricedCalls: row?.unpriced ?? 0
	};
}

export class BudgetExceededError extends Error {
	constructor(public status: BudgetStatus) {
		super(
			`Budget cap reached: $${status.spentUsd.toFixed(2)} of $${status.limitUsd.toFixed(2)} spent this ${status.period}. Raise or disable the cap in Admin → Settings.`
		);
		this.name = 'BudgetExceededError';
	}
}

/** Throws (and emits a budget event) when the cap is hit. */
export function assertBudget(userId: string, task: string): void {
	const status = getBudgetStatus();
	if (!status.blocked) return;
	emitEvent({
		userId,
		task,
		type: 'budget',
		name: `cap ${status.period} $${status.limitUsd}`,
		status: 'error',
		detail: { spentUsd: status.spentUsd, limitUsd: status.limitUsd, period: status.period }
	});
	throw new BudgetExceededError(status);
}
