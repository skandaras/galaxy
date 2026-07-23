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
	const row = db.get<{ spent: number }>(
		sql`SELECT COALESCE(SUM(cost_usd),0) AS spent FROM usage_log WHERE ts >= ${start}`
	);
	const spent = row?.spent ?? 0;
	return {
		enabled: cfg.enabled,
		limitUsd: cfg.limitUsd,
		period: cfg.period,
		spentUsd: spent,
		periodStart: start,
		blocked: cfg.enabled && spent >= cfg.limitUsd
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
