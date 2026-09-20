import { randomUUID } from 'node:crypto';
import type { LoopTool } from './loop';
import { runAgentLoop } from './loop';
import { completeJob, createJob } from './jobs';
import { getBudgetStatus } from './budget';
import { getTaskConfig, pickModel, systemPromptFor } from './engine';
import {
	createWorkspace,
	destroyWorkspace,
	repoInstructions,
	type CreatedWorkspace
} from './coding/workspace';

/**
 * How Forge's planning runs happen: in a workspace nobody sees, attached to no
 * conversation.
 *
 * The alternative was a real coding session, which would give each run a
 * transcript in /code — and leave every epic trailing chats and sessions that
 * nobody opened. The reasoning belongs in the charter and the sprint record,
 * which are documents a person actually reads, so the transcript would have
 * been a second copy of it with worse retention.
 *
 * The shape is `coding/explore.ts`'s, which is the one existing headless loop:
 * a job with `persist: false`, a synthetic chat id, and `buildMessages`
 * returning a plain array so the loop never reads a chat that does not exist.
 */

export interface HeadlessResult {
	text: string;
	steps: number;
}

/**
 * Clone, do something, and always clean up.
 *
 * A workspace left behind is a full checkout on the data volume for as long as
 * the install lives, and a planning run that throws is exactly when one would
 * be left.
 */
export async function withWorkspace<T>(
	repoUrl: string,
	from: string | undefined,
	fn: (ws: CreatedWorkspace) => Promise<T>
): Promise<T> {
	const ws = await createWorkspace(repoUrl, from ? { from } : {});
	try {
		return await fn(ws);
	} finally {
		destroyWorkspace(ws.workspaceRel);
	}
}

/** The repo's own instructions, appended as they are for a coding turn. */
export function forgeSystemPrompt(task: string, ws: CreatedWorkspace): string {
	return [
		systemPromptFor(task),
		`\nYou are reading the repository at branch ${ws.baseBranch}. It is checked out and you can read any of it.`,
		repoInstructions(ws.workspaceRel)
	]
		.filter(Boolean)
		.join('\n');
}

/**
 * Run one tool-using turn with no chat behind it and hand back what it said.
 *
 * `runAgentLoop` reports a dead model call by failing the job rather than
 * throwing, so an empty answer is ambiguous — the error chunk is the only way
 * to tell "it had nothing to say" from "it never ran". Explore learned that;
 * this reads it back the same way.
 */
export async function runHeadless(opts: {
	userId: string;
	task: string;
	/**
	 * The epic this run is spending against, carried in the synthetic chat id so
	 * `forgeSpend` can find it. Without it a charter, a sprint plan and every
	 * sprint review are spend the epic's ceiling cannot see, which is most of the
	 * planning bill.
	 */
	epicId?: string;
	system: string;
	user: string;
	tools: LoopTool[];
	maxIterations: number;
}): Promise<HeadlessResult> {
	const cfg = getTaskConfig(opts.task);
	const choice = pickModel(cfg?.primaryModelId ?? null, opts.task);
	if (!choice) throw new Error(`No model configured for ${opts.task} — set one in Admin → Tasks`);
	if (!choice.model.supportsTools) {
		throw new Error(
			`${choice.model.displayName} cannot call tools — pick another for ${opts.task} in Admin → Tasks`
		);
	}
	const backup = cfg?.backupModelId ? pickModel(cfg.backupModelId, opts.task) : null;

	// Its own id, never a real chat's: findRunningJobForChat scans live jobs by
	// chat id, and nothing here should ever be reported as holding a
	// conversation somebody is looking at. The epic id sits inside it so the
	// usage rows this run writes can still be summed back to the epic paying for
	// them — see forgeSpend, which matches on the prefix.
	const job = createJob({
		chatId: opts.epicId
			? `forge#${opts.epicId}#${opts.task}-${randomUUID().slice(0, 8)}`
			: `forge#${opts.task}-${randomUUID().slice(0, 8)}`,
		userId: opts.userId,
		task: opts.task,
		persist: false
	});

	let text = '';
	let steps = 0;
	await runAgentLoop({
		job,
		task: opts.task,
		userId: opts.userId,
		chatId: job.chatId,
		persist: false,
		primary: choice,
		backup,
		tools: opts.tools,
		maxIterations: opts.maxIterations,
		budgetBlocked: () => getBudgetStatus().blocked,
		// Closed below, once, so a run that failed is not also reported done.
		autoComplete: false,
		buildMessages: () => [
			{ role: 'system', content: opts.system },
			{ role: 'user', content: opts.user }
		],
		onDone: (reply, _usage, _choice, summary) => {
			text = reply.trim();
			steps = summary.steps;
		}
	});

	if (job.status === 'running') completeJob(job);
	if (!text) {
		const failure = job.chunks.findLast((c) => c.type === 'error');
		if (failure && failure.type === 'error') throw new Error(failure.message);
	}
	return { text, steps };
}
