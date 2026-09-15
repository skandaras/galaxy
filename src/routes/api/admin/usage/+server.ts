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

	const totals = db.get<{
		prompt: number;
		completion: number;
		cached: number;
		reasoning: number;
		cost: number;
		calls: number;
	}>(sql`
		SELECT COALESCE(SUM(prompt_tokens),0) AS prompt,
		       COALESCE(SUM(completion_tokens),0) AS completion,
		       COALESCE(SUM(cached_prompt_tokens),0) AS cached,
		       COALESCE(SUM(reasoning_tokens),0) AS reasoning,
		       COALESCE(SUM(cost_usd),0) AS cost,
		       COUNT(*) AS calls
		FROM usage_log WHERE ts >= ${since}`);

	const byDay = db.all(sql`
		SELECT strftime('%Y-%m-%d', ts/1000, 'unixepoch') AS day,
		       SUM(prompt_tokens) AS prompt, SUM(completion_tokens) AS completion,
		       COALESCE(SUM(cost_usd),0) AS cost, COUNT(*) AS calls
		FROM usage_log WHERE ts >= ${since}
		GROUP BY day ORDER BY day DESC`);

	// cached is grouped alongside prompt on purpose: the only useful reading of
	// prompt caching is the share of one model's prompt tokens that it served,
	// and a total across every model hides the one that is not caching at all.
	//
	// reasoning is here for the same reason and was missing for longer. The
	// column has been written since 9d7c83d, with a schema comment saying why —
	// "wrote a lot" and "deliberated a lot" are different problems with the same
	// completion total, and only the second is usually a fault — and then no
	// aggregate ever selected it. The one screen that reads it is the Cortex
	// page, for its own job alone, which is how a chat model spending four
	// fifths of every reply thinking stayed invisible here while being perfectly
	// visible there.
	const byModel = db.all(sql`
		SELECT model_key AS modelKey, task,
		       SUM(prompt_tokens) AS prompt, SUM(completion_tokens) AS completion,
		       COALESCE(SUM(cached_prompt_tokens),0) AS cached,
		       COALESCE(SUM(reasoning_tokens),0) AS reasoning,
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
