import { randomUUID } from 'node:crypto';
import { getBudgetStatus } from '../budget';
import { getTaskConfig, pickModel } from '../engine';
import { createJob, pushChunk, subscribeJob, type AgentKind, type LiveJob } from '../jobs';
import { runAgentLoop, type LoopTool, type ToolCallRecord } from '../loop';
import { resolveTextModel, type ModelChoice } from '$lib/server/providers/registry';
import { taskPath } from '$lib/admin-sections';

/**
 * What every agent run from inside another agent's tool call has in common:
 * which model it gets, how it shows on the parent's stream, and the child job
 * that carries it. Explore was the only such agent until workers; the shapes
 * here are what it had, so a second caller does not drift from the first.
 */

/**
 * Longest label or activity line on an `agent` chunk.
 *
 * Cut at the source rather than in the pane's CSS: the question is written by a
 * model and a tool's `describe` can return an arbitrary grep pattern, and this
 * is re-sent on every update.
 */
const MAX_LABEL_CHARS = 140;

export function resolveAgentModel(
	task: string,
	modelId?: string | null
): { choice: ModelChoice; backup: ModelChoice | null } {
	if (getBudgetStatus().blocked) {
		throw new Error('The spend cap has been reached — answer with what you already know.');
	}
	const cfg = getTaskConfig(task);
	const choice = pickModel(modelId ?? cfg?.primaryModelId ?? null, task);
	if (!choice) throw new Error(`No model configured for ${task}`);
	if (!choice.model.supportsTools) {
		throw new Error(`${choice.model.displayName} cannot call tools — pick another in ${taskPath(task)}`);
	}
	// Returned rather than applied: explore has always run without one, and a
	// fallback that quietly changes which model answers is the caller's call.
	const backup = cfg?.backupModelId ? resolveTextModel(cfg.backupModelId) : null;
	return { choice, backup };
}

/**
 * Announce a nested agent on the parent's stream, and keep it current.
 *
 * Its tool calls are forwarded as flattened rows with no identity, no start and
 * no end, which is enough for the transcript and not enough to answer "what is
 * running right now, and for how long". Same id every time, so a reconnecting
 * client converges instead of collecting one row per update.
 */
export function createAnnouncer(
	parent: LiveJob,
	row: { id: string; label: string; startedAt: number }
): (status: 'running' | 'ok' | 'error', kind: AgentKind, detail?: string) => void {
	return (status, kind, detail) =>
		pushChunk(parent, {
			type: 'agent',
			id: row.id,
			kind,
			// Capped here rather than in CSS: the label is model-authored and
			// unbounded, and this rides the wire on every update.
			label: row.label.slice(0, MAX_LABEL_CHARS),
			status,
			...(detail ? { detail: detail.slice(0, MAX_LABEL_CHARS) } : {}),
			startedAt: row.startedAt
		});
}

export async function runNestedAgent(o: {
	parent: { job: LiveJob; userId: string };
	task: string;
	rowPrefix: string;
	choice: ModelChoice;
	backup: ModelChoice | null;
	tools: LoopTool[];
	maxIterations: number;
	system: string;
	user: string;
	/** Called with each tool call as it starts, for the caller's announcer row. */
	onActivity?: (detail: string) => void;
}): Promise<{
	answer: string;
	steps: number;
	toolCalls: ToolCallRecord[];
	failure?: string;
	model: string;
}> {
	// A chat id of its own so the child never appears to be the run holding the
	// parent's chat: findRunningJobForChat scans live jobs by chat id, and a
	// child sharing one would be reported as the blocker. Unique per run, because
	// several can be in flight at once. It carries nothing of the parent's id: a
	// hidden session's id must not reach usage_log, and this one does.
	const job = createJob({
		chatId: `nested-${randomUUID()}`,
		userId: o.parent.userId,
		task: o.task,
		persist: false
	});
	// Subscribed before the loop starts, and for two reasons: failJob only rings
	// the notification bell when nothing is watching, and a child's failure is
	// the parent's tool error, not something to wake a phone for.
	const off = subscribeJob(job, (chunk) => {
		// Only the tool calls are forwarded, and as the parent's own chunks, so
		// the timeline shows what the child actually did rather than a pause.
		//
		// The child's stepId goes: it names a step in the child's timeline that
		// the parent has never heard of, and an unrecognised one opens a blank
		// orphan step (see applyChunk). Without it these hang under the parent's
		// current step, which is the one holding the dispatching call, exactly
		// where they belong.
		//
		// Through pushChunk rather than straight to the subscribers, so they are
		// recorded for replay on reconnect and keep the parent's lastChunkAt
		// fresh: a parent silent for the whole dispatch is what the
		// abandoned-run watchdog is looking for.
		if (chunk.type === 'tool') {
			const { stepId: _childStep, ...rest } = chunk;
			pushChunk(o.parent.job, { ...rest, name: `${o.rowPrefix} · ${chunk.name}` });
			if (chunk.status === 'running') {
				o.onActivity?.(chunk.detail ? `${chunk.name} ${chunk.detail}` : chunk.name);
			}
		}
	});
	// The parent stopping must stop this too, or a cancelled run keeps spending.
	const onAbort = () => job.controller.abort();
	o.parent.job.controller.signal.addEventListener('abort', onAbort, { once: true });

	let answer = '';
	let steps = 0;
	let toolCalls: ToolCallRecord[] = [];
	try {
		await runAgentLoop({
			job,
			task: o.task,
			userId: o.parent.userId,
			// Never the parent's chat: nothing here should be attributed to that
			// conversation, and persist is off so none of it is written anyway.
			chatId: job.chatId,
			persist: false,
			primary: o.choice,
			backup: o.backup,
			tools: o.tools,
			maxIterations: o.maxIterations,
			budgetBlocked: () => getBudgetStatus().blocked,
			// The parent's tool call is what "finishes" here; the job is a vehicle.
			autoComplete: false,
			// A tool in the child that needs a person's answer has to ask through
			// the job the browser is attached to; nobody watches the child.
			promptJob: o.parent.job,
			buildMessages: () => [
				{ role: 'system', content: o.system },
				{ role: 'user', content: o.user }
			],
			onDone: (text, _usage, _choice, summary) => {
				answer = text.trim();
				steps = summary.steps;
				toolCalls = summary.toolCalls;
			}
		});
	} finally {
		off();
		o.parent.job.controller.signal.removeEventListener('abort', onAbort);
	}

	// runAgentLoop reports a failed model call by failing its own job rather
	// than throwing, so without this a provider outage came back as "found
	// nothing", an answer the parent would reasonably act on.
	const error = answer ? undefined : job.chunks.findLast((c) => c.type === 'error');
	return {
		answer,
		steps,
		toolCalls,
		...(error && error.type === 'error' ? { failure: error.message } : {}),
		model: o.choice.model.modelKey
	};
}
