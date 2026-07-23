import { json } from '@sveltejs/kit';
import { sql } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/api';
import { db } from '$lib/server/db';
import { getBudgetStatus } from '$lib/server/engine/budget';

export const GET: RequestHandler = ({ locals, url }) => {
	requireAdmin(locals);
	const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 30, 1), 365);
	const since = Date.now() - days * 86_400_000;

	const totals = db.get<{ prompt: number; completion: number; cost: number; calls: number }>(sql`
		SELECT COALESCE(SUM(prompt_tokens),0) AS prompt,
		       COALESCE(SUM(completion_tokens),0) AS completion,
		       COALESCE(SUM(cost_usd),0) AS cost,
		       COUNT(*) AS calls
		FROM usage_log WHERE ts >= ${since}`);

	const byDay = db.all(sql`
		SELECT strftime('%Y-%m-%d', ts/1000, 'unixepoch') AS day,
		       SUM(prompt_tokens) AS prompt, SUM(completion_tokens) AS completion,
		       COALESCE(SUM(cost_usd),0) AS cost, COUNT(*) AS calls
		FROM usage_log WHERE ts >= ${since}
		GROUP BY day ORDER BY day DESC`);

	const byModel = db.all(sql`
		SELECT model_key AS modelKey, task,
		       SUM(prompt_tokens) AS prompt, SUM(completion_tokens) AS completion,
		       COALESCE(SUM(cost_usd),0) AS cost, COUNT(*) AS calls,
		       SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors
		FROM usage_log WHERE ts >= ${since}
		GROUP BY model_key, task ORDER BY cost DESC`);

	const byUser = db.all(sql`
		SELECT COALESCE(u.username, l.user_id) AS username,
		       SUM(l.prompt_tokens) AS prompt, SUM(l.completion_tokens) AS completion,
		       COALESCE(SUM(l.cost_usd),0) AS cost, COUNT(*) AS calls
		FROM usage_log l LEFT JOIN users u ON u.id = l.user_id
		WHERE l.ts >= ${since}
		GROUP BY l.user_id ORDER BY cost DESC`);

	return json({ days, totals, byDay, byModel, byUser, budget: getBudgetStatus() });
};
