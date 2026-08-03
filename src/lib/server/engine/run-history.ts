import { and, desc, eq, gte, lte } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { events, jobs } from '$lib/server/db/schema';
import { getMessages } from '$lib/server/chats';
import type { ToolDef } from '$lib/server/providers/types';
import { recentFinishedJobsForChat } from './jobs';
import type { LoopTool } from './loop';

export interface RunRecord {
	id: string;
	task: string;
	status: 'done' | 'error' | 'cancelled' | 'running';
	error: string | null;
	startedAt: number;
	finishedAt: number | null;
}

/** Tool calls are only recorded for chats that persist; hidden ones have none. */
export interface RunStep {
	name: string;
	status: 'ok' | 'error' | 'running';
	durationMs: number | null;
	summary: string;
	error: string | null;
}

const MAX_RUNS = 10;

/**
 * Finished runs on this conversation, newest first.
 *
 * Reads the jobs table, then folds in anything still in the in-memory buffer —
 * which is the only record a hidden chat ever has.
 */
export function recentRuns(chatId: string, limit = 5): RunRecord[] {
	const persisted: RunRecord[] = db
		.select()
		.from(jobs)
		.where(eq(jobs.chatId, chatId))
		.orderBy(desc(jobs.createdAt))
		.limit(Math.min(limit, MAX_RUNS))
		.all()
		.map((j) => ({
			id: j.id,
			task: j.task,
			status: j.status,
			error: j.error,
			startedAt: j.createdAt.getTime(),
			finishedAt: j.finishedAt?.getTime() ?? null
		}));

	const seen = new Set(persisted.map((r) => r.id));
	const live: RunRecord[] = recentFinishedJobsForChat(chatId)
		.filter((j) => !seen.has(j.id))
		.map((j) => ({
			id: j.id,
			task: j.task,
			status: j.status,
			// The buffer holds the chunks rather than an error column; the error
			// chunk is where a failed run says what happened.
			error:
				j.chunks.find((c): c is { type: 'error'; message: string } => c.type === 'error')
					?.message ?? null,
			startedAt: j.createdAt,
			finishedAt: null
		}));

	return [...persisted, ...live]
		.sort((a, b) => b.startedAt - a.startedAt)
		.slice(0, Math.min(limit, MAX_RUNS));
}

/** What the agent did during one run, from the Observatory's tool-call events. */
export function runSteps(chatId: string, run: RunRecord): RunStep[] {
	const rows = db
		.select()
		.from(events)
		.where(
			and(
				eq(events.chatId, chatId),
				eq(events.type, 'tool.call'),
				gte(events.ts, new Date(run.startedAt)),
				lte(events.ts, new Date(run.finishedAt ?? Date.now()))
			)
		)
		.orderBy(events.ts)
		.all();

	return rows.map((r) => {
		const detail = (r.detail ?? {}) as Record<string, unknown>;
		return {
			name: r.name,
			status: r.status,
			durationMs: r.durationMs,
			summary: String(detail.summary ?? ''),
			error: detail.error ? String(detail.error) : null
		};
	});
}

/**
 * Why a run stopped, from the turn event the loop writes on the way out.
 * 'complete' means the model said it was finished; 'exhausted' means it ran out
 * of steps with work still outstanding, and 'budget' means the cap cut it off —
 * both of which end a run as `done` while leaving it half-finished.
 */
export function runStopReason(chatId: string, run: RunRecord): string | null {
	const row = db
		.select()
		.from(events)
		.where(
			and(
				eq(events.chatId, chatId),
				eq(events.type, 'job'),
				eq(events.status, 'ok'),
				gte(events.ts, new Date(run.startedAt)),
				lte(events.ts, new Date(run.finishedAt ?? Date.now()))
			)
		)
		.orderBy(desc(events.ts))
		.limit(1)
		.get();
	const detail = (row?.detail ?? {}) as Record<string, unknown>;
	return detail.stopReason ? String(detail.stopReason) : null;
}

const ago = (ts: number, now = Date.now()): string => {
	const mins = Math.round((now - ts) / 60_000);
	if (mins < 1) return 'just now';
	if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
	const hours = Math.round(mins / 60);
	if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
	return `${Math.round(hours / 24)} day(s) ago`;
};

/**
 * A note for the system prompt when the last attempt on this conversation did
 * not finish.
 *
 * Without it a failed turn is invisible to the next one: the user's message is
 * in the history, no reply follows it, and nothing says why — so "any update?"
 * gets the whole attempt run again from the top, failing the same way. Empty
 * when the previous run completed normally, which is the common case.
 */
export function previousRunNote(chatId: string, now = Date.now()): string {
	const previous = recentRuns(chatId, 3).find((r) => r.status !== 'running');
	if (!previous) return '';

	// A run can end `done` and still leave the user with nothing: out of steps,
	// cut off by the spend cap, or an answer that came back empty. Those had no
	// trace at all — the reply is simply missing and the next turn has no idea
	// why. Anything else that finished is the ordinary case and says nothing.
	const stopReason = previous.status === 'done' ? runStopReason(chatId, previous) : null;
	const unfinished = stopReason === 'exhausted' || stopReason === 'budget';
	const emptyReply = previous.status === 'done' && lastReplyWasEmpty(chatId);
	if (previous.status === 'done' && !unfinished && !emptyReply) return '';

	const what = (): string => {
		if (previous.status === 'cancelled') {
			return 'The last run was stopped by the user before it finished.';
		}
		if (previous.status === 'error') {
			return `The last run failed and produced no reply. Reason: ${previous.error ?? 'not recorded'}`;
		}
		if (stopReason === 'budget') {
			return 'The last run was cut off partway through by the spend cap, so whatever it was doing is unfinished.';
		}
		if (stopReason === 'exhausted') {
			return 'The last run used up its step budget before the model said it was done, so the work is probably incomplete.';
		}
		return 'The last run finished but returned an empty reply — the user saw nothing at all.';
	};

	const lines = ['', `[Previous attempt on this conversation — ${ago(previous.startedAt, now)}]`, what()];

	const steps = runSteps(chatId, previous);
	if (steps.length) {
		const failed = steps.filter((s) => s.status === 'error');
		lines.push(
			`It got through ${steps.length} tool call${steps.length === 1 ? '' : 's'} first: ${steps
				.slice(-6)
				.map((s) => `${s.name}${s.status === 'error' ? ' (failed)' : ''}`)
				.join(', ')}`
		);
		for (const f of failed.slice(-3)) {
			lines.push(`  ${f.name} failed: ${f.error ?? 'no detail'}`);
		}
	}

	lines.push(
		previous.status === 'cancelled' || unfinished
			? 'Continue from where it got to rather than starting over — call run_history for what it already did — and say briefly what you are picking up from.'
			: 'Do not simply repeat that attempt. Work out what went wrong first — call run_history if you need the detail — and either take a different route or tell the user plainly what is blocking it.'
	);
	return lines.join('\n');
}

/**
 * True when the newest stored message is an assistant reply with nothing in it.
 *
 * This is the "it just didn't answer" case as the user experiences it, and it
 * leaves no error anywhere: the run is recorded as a success and an empty
 * message is saved, so without this check the next turn sees a blank reply and
 * no reason for it.
 */
function lastReplyWasEmpty(chatId: string): boolean {
	const last = getMessages(chatId).at(-1);
	return last?.role === 'assistant' && !last.content.trim();
}

export const runHistoryToolDef: ToolDef = {
	name: 'run_history',
	description:
		'Look at what happened on recent attempts in this conversation — the same record the ' +
		'Observatory shows: how each run ended, which tools it called, and any errors. Use this ' +
		'when a previous attempt failed or was stopped and you need to know why before trying ' +
		'again, rather than repeating work that has already been done or has already failed.',
	parameters: {
		type: 'object',
		properties: {
			limit: {
				type: 'number',
				description: 'How many recent runs to describe (default 3, maximum 10)'
			}
		}
	}
};

/** Bound to the chat it was built for: a run's history is never another chat's. */
export function runHistoryTool(chatId: string): LoopTool {
	return {
		def: runHistoryToolDef,
		describe: () => 'recent runs',
		execute: async (args) => {
			const limit = Math.max(1, Math.min(Number(args.limit) || 3, MAX_RUNS));
			return formatRunHistory(chatId, limit);
		}
	};
}

export function formatRunHistory(chatId: string, limit: number, now = Date.now()): string {
	// The run in progress is the one asking; describing it back is noise.
	const runs = recentRuns(chatId, limit + 1).filter((r) => r.status !== 'running').slice(0, limit);
	if (!runs.length) {
		return 'No earlier runs are recorded for this conversation. (Hidden chats keep nothing on disk, and history is trimmed by the retention window.)';
	}

	const out: string[] = [];
	for (const run of runs) {
		const took = run.finishedAt ? ` in ${Math.round((run.finishedAt - run.startedAt) / 1000)}s` : '';
		out.push(`## ${run.task} run, ${ago(run.startedAt, now)} — ${run.status}${took}`);
		if (run.error) out.push(`error: ${run.error}`);

		const steps = runSteps(chatId, run);
		if (!steps.length) {
			out.push('(no tool calls recorded)');
			continue;
		}
		for (const s of steps) {
			const detail = [s.summary, s.error ? `error: ${s.error}` : '']
				.filter(Boolean)
				.join(' — ');
			out.push(
				`- ${s.name} ${s.status}${s.durationMs ? ` (${s.durationMs}ms)` : ''}${detail ? `: ${detail}` : ''}`
			);
		}
	}
	return out.join('\n');
}
