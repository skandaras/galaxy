import { reasoningFor } from '$lib/server/providers/registry';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { uxIdeas } from '$lib/server/db/schema';
import {
	DEFAULT_UX_AUDIT,
	getSetting,
	setSetting,
	type UxAuditSettings
} from '$lib/server/settings';
import { getBudgetStatus } from './budget';
import { getTaskConfig, pickModel } from './engine';
import { emitEvent } from './events';
import { extractJson } from './json';
import { logUsage } from './usage';

const LAST_RUN_KEY = 'ux.lastRun';

/**
 * Window used on the very first run, when there is no previous run to measure
 * from. Long enough to see a pattern, short enough that the first audit is
 * about how the platform is used *now*.
 */
const FIRST_RUN_WINDOW_MS = 30 * 86_400_000;

/**
 * Per-section prompt budgets. The interface source is the biggest and the most
 * useful — telemetry says *that* something is wrong, the source is what lets an
 * idea name the control to change.
 */
const MAX_TELEMETRY_CHARS = 12_000;
const MAX_UI_CHARS = 45_000;
const MAX_HISTORY_CHARS = 8_000;
/** Prior ideas replayed to the agent, newest first. */
const MAX_HISTORY_ITEMS = 200;

const AREAS = [
	'chat',
	'code',
	'admin',
	'library',
	'observatory',
	'settings',
	'mobile',
	'general'
] as const;

export type UxIdea = typeof uxIdeas.$inferSelect;

export function getUxStatus(): { lastRun: number; open: number; total: number } {
	const totals = db
		.select({ status: uxIdeas.status, n: sql<number>`count(*)` })
		.from(uxIdeas)
		.groupBy(uxIdeas.status)
		.all();
	return {
		lastRun: getSetting<number>(LAST_RUN_KEY, 0),
		open: totals.find((t) => t.status === 'open')?.n ?? 0,
		total: totals.reduce((sum, t) => sum + t.n, 0)
	};
}

export function listUxIdeas(): UxIdea[] {
	// Ordered by id as a tie-break: one run inserts several rows inside the same
	// millisecond, so the timestamp alone leaves their order to the engine.
	return db.select().from(uxIdeas).orderBy(desc(uxIdeas.createdAt), uxIdeas.id).all();
}

/**
 * Dismiss an idea. Both outcomes remove it from the open list — the difference
 * is only what the owner tells the agent about why, and both are replayed to
 * future runs so the same idea is not raised twice.
 */
export function decideUxIdea(id: string, action: 'actioned' | 'discard'): UxIdea | null {
	const res = db
		.update(uxIdeas)
		.set({ status: action === 'actioned' ? 'actioned' : 'discarded', decidedAt: new Date() })
		.where(and(eq(uxIdeas.id, id), eq(uxIdeas.status, 'open')))
		.run();
	if (!res.changes) return null;
	return db.select().from(uxIdeas).where(eq(uxIdeas.id, id)).get() ?? null;
}

/**
 * Normalised title, used to reject a re-proposal the model has merely reworded.
 * Not foolproof — the prompt does the real work by showing what came before —
 * but it costs nothing and catches verbatim repeats.
 */
export function fingerprint(title: string): string {
	return title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '')
		.slice(0, 80);
}

/**
 * Aggregated platform telemetry for the window.
 *
 * Everything here is a count, a duration or a name the platform itself chose
 * (a task, a tool, an event name). No message, chat title, memory or attachment
 * content is read — the auditor is a platform-wide, admin-visible surface, and
 * the rule that one user's conversation content never crosses into one of those
 * holds here exactly as it does for the memory agent.
 */
export function telemetryDigest(sinceMs: number, now = Date.now()): string {
	const days = Math.max(1, Math.round((now - sinceMs) / 86_400_000));
	const sections: string[] = [`Window: last ${days} day(s).`];

	const rows = <T>(label: string, result: T[], render: (r: T) => string): void => {
		if (!result.length) return;
		sections.push(`### ${label}\n${result.map(render).join('\n')}`);
	};

	rows(
		'Runs by task and outcome',
		db.all<{ task: string; status: string; n: number; avgS: number | null; maxS: number | null }>(
			sql`SELECT task, status, COUNT(*) AS n,
			           ROUND(AVG(CASE WHEN finished_at IS NOT NULL
			                          THEN finished_at - created_at END) / 1000.0, 1) AS avgS,
			           ROUND(MAX(finished_at - created_at) / 1000.0, 1) AS maxS
			    FROM jobs WHERE created_at >= ${sinceMs}
			    GROUP BY task, status ORDER BY n DESC`
		),
		(r) =>
			`- ${r.task} · ${r.status}: ${r.n} run(s)` +
			(r.avgS != null ? `, avg ${r.avgS}s, slowest ${r.maxS}s` : '')
	);

	rows(
		'Engine events by kind',
		db.all<{ type: string; status: string; n: number }>(
			sql`SELECT type, status, COUNT(*) AS n FROM events
			    WHERE ts >= ${sinceMs} GROUP BY type, status ORDER BY n DESC LIMIT 30`
		),
		(r) => `- ${r.type} · ${r.status}: ${r.n}`
	);

	rows(
		'Most frequent failures',
		db.all<{ name: string; task: string | null; n: number }>(
			sql`SELECT name, task, COUNT(*) AS n FROM events
			    WHERE ts >= ${sinceMs} AND status = 'error'
			    GROUP BY name, task ORDER BY n DESC LIMIT 15`
		),
		(r) => `- ${r.name}${r.task ? ` (${r.task})` : ''}: ${r.n} failure(s)`
	);

	rows(
		'Tool use',
		db.all<{ name: string; n: number; errors: number; avgMs: number | null }>(
			sql`SELECT name, COUNT(*) AS n,
			           SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
			           ROUND(AVG(duration_ms)) AS avgMs
			    FROM events WHERE ts >= ${sinceMs} AND type = 'tool.call'
			    GROUP BY name ORDER BY n DESC LIMIT 20`
		),
		(r) => `- ${r.name}: ${r.n} call(s), ${r.errors} failed${r.avgMs ? `, avg ${r.avgMs}ms` : ''}`
	);

	rows(
		'Model calls by task',
		db.all<{ task: string; calls: number; errors: number; cost: number }>(
			sql`SELECT task, COUNT(*) AS calls,
			           SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
			           COALESCE(SUM(cost_usd), 0) AS cost
			    FROM usage_log WHERE ts >= ${sinceMs}
			    GROUP BY task ORDER BY calls DESC`
		),
		(r) => `- ${r.task}: ${r.calls} call(s), ${r.errors} error(s), $${r.cost.toFixed(2)}`
	);

	const shape = db.get<{
		chats: number;
		codeChats: number;
		msgs: number;
		userMsgs: number;
		attachments: number;
		docs: number;
		sessions: number;
		planSessions: number;
	}>(
		sql`SELECT
		      (SELECT COUNT(*) FROM chats WHERE created_at >= ${sinceMs}) AS chats,
		      (SELECT COUNT(*) FROM chats WHERE created_at >= ${sinceMs} AND mode = 'code') AS codeChats,
		      (SELECT COUNT(*) FROM messages WHERE created_at >= ${sinceMs}) AS msgs,
		      (SELECT COUNT(*) FROM messages WHERE created_at >= ${sinceMs} AND role = 'user') AS userMsgs,
		      (SELECT COUNT(*) FROM attachments WHERE created_at >= ${sinceMs}) AS attachments,
		      (SELECT COUNT(*) FROM attachments WHERE created_at >= ${sinceMs} AND kind = 'document') AS docs,
		      (SELECT COUNT(*) FROM code_sessions WHERE created_at >= ${sinceMs}) AS sessions,
		      (SELECT COUNT(*) FROM code_sessions WHERE created_at >= ${sinceMs} AND mode = 'plan') AS planSessions`
	);
	if (shape) {
		sections.push(
			[
				'### Activity shape (counts only)',
				`- Conversations started: ${shape.chats} (${shape.codeChats} in code mode)`,
				`- Messages: ${shape.msgs} total, ${shape.userMsgs} written by a person` +
					(shape.chats ? ` — ${(shape.msgs / shape.chats).toFixed(1)} per conversation` : ''),
				`- Attachments uploaded: ${shape.attachments} (${shape.docs} document(s))`,
				`- Coding sessions: ${shape.sessions} (${shape.planSessions} started in plan mode)`
			].join('\n')
		);
	}

	rows(
		'When it gets used (hour of day, server local)',
		db.all<{ hour: string; n: number }>(
			sql`SELECT strftime('%H', created_at / 1000, 'unixepoch', 'localtime') AS hour,
			           COUNT(*) AS n
			    FROM messages WHERE created_at >= ${sinceMs} AND role = 'user'
			    GROUP BY hour HAVING n > 0 ORDER BY hour`
		),
		(r) => `- ${r.hour}:00 — ${r.n} message(s)`
	);

	const text = sections.join('\n\n');
	return text.length > MAX_TELEMETRY_CHARS ? `${text.slice(0, MAX_TELEMETRY_CHARS)}\n…` : text;
}

/**
 * The interface, as source.
 *
 * Vite inlines these at build time, which is what makes this work in
 * production: the runtime image ships only `build/`, `node_modules/` and
 * `drizzle/` (see the Dockerfile), so there is no `src/` on disk to read.
 * Loaded lazily so the raw text is only pulled into memory during a run.
 */
const uiSources = {
	...import.meta.glob('/src/routes/**/*.svelte', { query: '?raw', import: 'default' }),
	...import.meta.glob('/src/lib/components/**/*.svelte', { query: '?raw', import: 'default' })
} as Record<string, () => Promise<string>>;

/** Pages before components, and the two surfaces in daily use before either. */
function uiPriority(path: string): number {
	if (path.includes('/routes/chat/') || path.includes('/routes/code/')) return 0;
	if (path.includes('/routes/+layout')) return 1;
	if (path.includes('/routes/')) return 2;
	return 3;
}

export async function uiDigest(budget = MAX_UI_CHARS): Promise<string> {
	const paths = Object.keys(uiSources).sort((a, b) => uiPriority(a) - uiPriority(b) || a.localeCompare(b));
	const parts: string[] = [];
	const skipped: string[] = [];
	let used = 0;

	for (const path of paths) {
		if (used >= budget) {
			skipped.push(path);
			continue;
		}
		const source = await uiSources[path]();
		const room = budget - used;
		const body = source.length > room ? `${source.slice(0, room)}\n… (truncated)` : source;
		used += body.length;
		parts.push(`--- ${path} ---\n${body}`);
	}

	if (skipped.length) {
		parts.push(`(${skipped.length} further file(s) omitted for length: ${skipped.join(', ')})`);
	}
	return parts.join('\n\n');
}

/**
 * Everything already proposed, and what became of it. This is the whole
 * mechanism for "don't suggest it again": an idea marked actioned is done, and
 * one marked discarded was considered and rejected — neither should come back.
 */
export function historyDigest(): string {
	const prior = db
		.select({
			title: uxIdeas.title,
			area: uxIdeas.area,
			status: uxIdeas.status
		})
		.from(uxIdeas)
		.orderBy(desc(uxIdeas.createdAt), uxIdeas.id)
		.limit(MAX_HISTORY_ITEMS)
		.all();
	if (!prior.length) return '(nothing has been proposed yet)';
	const text = prior
		.map((p) => `- [${p.status}] (${p.area}) ${p.title}`)
		.join('\n');
	return text.length > MAX_HISTORY_CHARS ? `${text.slice(0, MAX_HISTORY_CHARS)}\n…` : text;
}

/**
 * The whole user turn for one audit. Exported so the guarantee this module
 * makes — aggregates and interface source, never conversation content — is
 * assertable in a test against the real prompt rather than its ingredients.
 */
export async function buildAuditPrompt(opts: {
	since: number;
	now?: number;
	maxIdeas: number;
}): Promise<string> {
	return [
		`UX-AUDIT: Review Galaxy for usability problems worth fixing. Propose at most ${opts.maxIdeas} ideas.`,
		'Reply with ONLY a JSON object: {"ideas":[{"title":"short imperative headline","area":"' +
			AREAS.join('|') +
			'","severity":"low|medium|high","effort":"s|m|l","problem":"what is wrong for the person using it","proposal":"what to change","evidence":"the telemetry pattern or the file and control this comes from"}]}',
		'Rules: ground every idea in the telemetry or the source below — no generic best-practice advice. One idea per problem. Do not repeat anything under ALREADY PROPOSED, whatever its status: "actioned" means it is already built and "discarded" means the owner considered and rejected it.',
		`--- ALREADY PROPOSED ---\n${historyDigest()}`,
		`--- USAGE TELEMETRY (aggregates only; conversation content is never shared) ---\n${telemetryDigest(opts.since, opts.now)}`,
		`--- INTERFACE SOURCE ---\n${await uiDigest()}`
	].join('\n\n');
}

/**
 * File this run's proposals, dropping anything already raised.
 *
 * The fingerprint check covers every status, not just open ideas: something
 * already actioned is built, and something discarded was considered and turned
 * down — neither should reappear. The prompt asks for the same thing; this is
 * the half that does not depend on the model having read it.
 */
export function recordIdeas(
	proposals: unknown[],
	maxIdeas: number
): { added: number; duplicates: number } {
	const known = new Set(
		db.select({ fingerprint: uxIdeas.fingerprint }).from(uxIdeas).all().map((r) => r.fingerprint)
	);
	let added = 0;
	let duplicates = 0;

	for (const raw of proposals.slice(0, maxIdeas)) {
		const idea = (raw ?? {}) as Record<string, unknown>;
		const title = String(idea.title ?? '').trim();
		if (!title) continue;
		const fp = fingerprint(title);
		if (!fp || known.has(fp)) {
			duplicates++;
			continue;
		}
		known.add(fp);
		db.insert(uxIdeas)
			.values({
				id: randomUUID(),
				title: title.slice(0, 200),
				area: AREAS.includes(idea.area as (typeof AREAS)[number]) ? String(idea.area) : 'general',
				severity: ['low', 'medium', 'high'].includes(idea.severity as string)
					? (idea.severity as 'low' | 'medium' | 'high')
					: 'medium',
				effort: ['s', 'm', 'l'].includes(idea.effort as string)
					? (idea.effort as 's' | 'm' | 'l')
					: 'm',
				problem: String(idea.problem ?? '').slice(0, 2000),
				proposal: String(idea.proposal ?? '').slice(0, 2000),
				evidence: String(idea.evidence ?? '').slice(0, 2000),
				fingerprint: fp,
				status: 'open',
				createdAt: new Date()
			})
			.run();
		added++;
	}
	return { added, duplicates };
}

export interface UxAuditResult {
	ran: boolean;
	reason?: string;
	ideas?: number;
	/** Proposals dropped because the same idea has been raised before. */
	duplicates?: number;
}

/**
 * One UX audit: look at how the platform has actually been used since the last
 * run, look at the interface itself, and file ideas for the owner to skim.
 * Nothing is ever actioned from here — every idea waits for a human.
 */
export async function runUxAudit(trigger: 'schedule' | 'manual'): Promise<UxAuditResult> {
	const startedAt = Date.now();
	const cfg = getSetting<UxAuditSettings>('uxaudit', DEFAULT_UX_AUDIT);

	if (getBudgetStatus().blocked) {
		emitEvent({
			task: 'ux-audit',
			type: 'job',
			name: 'ux-audit.run',
			status: 'error',
			detail: { trigger, skipped: true, reason: 'budget cap reached' }
		});
		return { ran: false, reason: 'budget cap reached' };
	}

	const taskCfg = getTaskConfig('ux-audit');
	const choice = pickModel(taskCfg?.primaryModelId ?? null);
	if (!choice) {
		emitEvent({
			task: 'ux-audit',
			type: 'job',
			name: 'ux-audit.run',
			status: 'error',
			detail: { trigger, reason: 'no model configured' }
		});
		return { ran: false, reason: 'no model configured' };
	}

	const lastRun = getSetting<number>(LAST_RUN_KEY, 0);
	const since = lastRun || startedAt - FIRST_RUN_WINDOW_MS;
	const maxIdeas = Math.max(1, Math.min(cfg.maxIdeasPerRun ?? 8, 20));

	try {
		const { text, usage } = await choice.adapter.complete(
			{
				modelKey: choice.model.modelKey,
				messages: [
					{ role: 'system', content: taskCfg?.systemPrompt ?? '' },
					{
						role: 'user',
						content: await buildAuditPrompt({ since, now: startedAt, maxIdeas })
					}
				],
				maxTokens: 4096,
				// Reads what it was given and emits a short structured answer, which is
				// the class of task where deliberation buys nothing and costs the wall
				// clock. Sent only to models that accept it — see reasoningFor.
				reasoning: reasoningFor(choice, 'low')
			},
			AbortSignal.timeout(180_000)
		);

		const parsed = extractJson(text);
		const proposals = Array.isArray(parsed?.ideas) ? parsed.ideas : [];
		const { added, duplicates } = recordIdeas(proposals, maxIdeas);

		// Only advance on a run that completed, so a failure re-reads the same
		// window next time instead of losing a week of activity.
		setSetting(LAST_RUN_KEY, startedAt);
		logUsage({ task: 'ux-audit', choice, usage: usage, status: 'ok' });
		emitEvent({
			task: 'ux-audit',
			type: 'job',
			name: 'ux-audit.run',
			status: 'ok',
			durationMs: Date.now() - startedAt,
			detail: { trigger, ideas: added, duplicates }
		});
		return { ran: true, ideas: added, duplicates };
	} catch (err) {
		logUsage({ task: 'ux-audit', choice, usage: null, status: 'error' });
		emitEvent({
			task: 'ux-audit',
			type: 'job',
			name: 'ux-audit.run',
			status: 'error',
			durationMs: Date.now() - startedAt,
			detail: { trigger, error: String(err) }
		});
		return { ran: false, reason: String(err) };
	}
}
