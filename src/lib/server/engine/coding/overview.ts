import { and, desc, eq, gt } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import { db } from '$lib/server/db';
import { models, usageLog } from '$lib/server/db/schema';
import type { SessionOverview } from '$lib/session-panel';
import { listServerTools, serversFor } from '../tools/mcp';
import { loadToolSettings, toolAllowed } from '../tools/registry';
import { resolveExecutorKind } from './executor';
import { githubRepoSlug } from './pull-request';
import type { CodeSession } from './session';
import { loadState } from './state';

/**
 * Everything the coding page's session panel shows, in one read.
 *
 * Reads the database and the session's state row and runs no git. The page
 * asks for this after every settled step of a run, and in docker mode each
 * git command is a fresh container; the git figures here are the ones the
 * end of the last leg already counted.
 *
 * The caller has already found the session by its owner, and the queries
 * below scope by that owner again rather than trusting it.
 */
export function sessionOverview(session: CodeSession, userId: string): SessionOverview {
	const state = loadState(session.chatId);
	const slug = githubRepoSlug(session.repoUrl);
	return {
		environment: {
			executor: resolveExecutorKind(env.CODING_EXECUTOR),
			repoName: session.repoName,
			repoWebUrl: slug ? `https://github.com/${slug}` : null,
			baseBranch: session.baseBranch,
			workBranch: session.workBranch
		},
		context: lastContext(session.chatId, userId),
		connectors: connectors(),
		goal: state?.goal ?? null,
		plan: state?.plan ?? [],
		filesChanged: state?.filesChanged ?? [],
		changes: {
			totals: state?.totals ?? null,
			// Whole lines only: the stored log is cut at a line boundary.
			commits: (state?.commits ?? '').split('\n').filter(Boolean),
			prUrl: session.prUrl
		},
		checks: (['pre_commit', 'pre_push'] as const).flatMap((stage) => {
			const result = state?.checks?.[stage];
			return result ? [{ stage, ...result }] : [];
		})
	};
}

/**
 * How full the context was at the latest coding call that reported usage.
 *
 * Compaction is logged under the chat task and an explore sub-agent's calls
 * carry no chat id, so the task filter leaves the main agent's own calls. A
 * provider that sent no usage logs zero tokens, which would read as an empty
 * window, so those rows are skipped too.
 */
function lastContext(chatId: string, userId: string): SessionOverview['context'] {
	const row = db
		.select({
			modelKey: usageLog.modelKey,
			promptTokens: usageLog.promptTokens,
			completionTokens: usageLog.completionTokens,
			ts: usageLog.ts
		})
		.from(usageLog)
		.where(
			and(
				eq(usageLog.chatId, chatId),
				eq(usageLog.userId, userId),
				eq(usageLog.task, 'coding'),
				eq(usageLog.status, 'ok'),
				gt(usageLog.promptTokens, 0)
			)
		)
		.orderBy(desc(usageLog.ts))
		.limit(1)
		.get();
	if (!row) return null;
	return {
		usedTokens: row.promptTokens + row.completionTokens,
		contextWindow: windowFor(row.modelKey),
		modelKey: row.modelKey,
		at: row.ts.getTime()
	};
}

/**
 * The usage row names a model key and nothing else, and two providers can
 * serve the same key with different windows. The chat's chosen model does not
 * settle it, because a failover to a backup under the same key is logged the
 * same way. So a window is given only when every row with the key agrees on
 * it, and the panel says "window unknown" rather than show the wrong one.
 */
export function windowFor(modelKey: string): number | null {
	const windows = new Set(
		db
			.select({ contextWindow: models.contextWindow })
			.from(models)
			.where(eq(models.modelKey, modelKey))
			.all()
			.map((r) => r.contextWindow)
	);
	const [only] = windows;
	return windows.size === 1 ? (only ?? null) : null;
}

/**
 * The MCP servers a coding turn is offered, counted after the admin tool
 * policy so the panel agrees with what the agent is actually given. Names
 * and counts only: a server row also holds its URL, headers and environment.
 */
function connectors(): SessionOverview['connectors'] {
	const settings = loadToolSettings();
	return serversFor('coding')
		.map((server) => ({
			name: server.name,
			tools: listServerTools(server.id).filter((t) => toolAllowed(t.name, 'coding', settings))
				.length
		}))
		.filter((c) => c.tools > 0);
}
