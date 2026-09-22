import type { ForgeCheck } from '$lib/server/db/schema';
import {
	countAttempt,
	countSprintAttempt,
	gateRunsFor,
	getEpic,
	listSprints,
	listTasks,
	markStepped,
	recordGateRun,
	setEpicState,
	setSprintState,
	setTaskState,
	snapshot,
	type ForgeEpic,
	type ForgeSprint,
	type ForgeTask
} from '$lib/server/forge';
import { saveDoc } from '$lib/server/library';
import { notify } from '$lib/server/notifications';
import { forgeSettings as settings } from '$lib/server/settings';
import { emitEvent } from './events';
import { nextStep, type ForgeStep } from './forge-step';
import { gateReport, runGate } from './forge-gate';
import { runSprintPlan } from './forge-sprint';
import { runSprintReview } from './forge-review';
import { withWorkspace } from './forge-agent';
import { mirrorSprint, mirrorTask, mirrorTaskState } from './forge-mirror';
import { createSession, destroySession, getSession, startCodingTurn } from './coding/session';
import { mergeIntoBranch, scrubSecrets, shellQuote } from './coding/workspace';
import { getExecutor } from './coding/executor';
import { openPullRequest } from './coding/pull-request';
import { subscribeJob, type JobChunk } from './jobs';

/**
 * Advancing an epic by exactly one step.
 *
 * The only thing that moves Forge's rows. `nextStep` says what should happen
 * and this does it — the split is what lets the ordering be a pure function
 * with no clock, no container and no model in it.
 *
 * A step is deliberately small and self-contained, because an epic is rows
 * rather than a process: a restart between two steps loses nothing, and the
 * boot reconcile in G3 only ever has one half-finished thing to tidy.
 */

export interface StepOutcome {
	step: ForgeStep['kind'] | 'none';
	reason?: string;
	/** Set when the step started a coding job instead of finishing inline. */
	started?: { chatId: string; jobId: string };
	detail?: Record<string, unknown>;
}

export async function runStep(epic: ForgeEpic, userId: string): Promise<StepOutcome> {
	const snap = snapshot(epic.id, userId);
	if (!snap) return { step: 'none', reason: 'no such epic' };
	const step = nextStep(snap);
	if (!step) {
		return { step: 'none', reason: `nothing to do while the epic is ${snap.epic.state}` };
	}
	markStepped(epic.id);

	const startedAt = Date.now();
	try {
		const outcome = await dispatch(snap.epic, step, userId);
		emitEvent({
			userId,
			task: 'coding',
			type: 'job',
			name: `forge.${step.kind}`,
			status: 'ok',
			durationMs: Date.now() - startedAt,
			detail: { epicId: epic.id, ...outcome.detail }
		});
		return outcome;
	} catch (err) {
		// The envelope every sweep in this codebase has: a failure before the
		// agent could report one must still reach the Observatory, or the step
		// simply went dark.
		emitEvent({
			userId,
			task: 'coding',
			type: 'job',
			name: `forge.${step.kind}`,
			status: 'error',
			durationMs: Date.now() - startedAt,
			detail: { epicId: epic.id, reason: String(err).slice(0, 500) }
		});
		return { step: step.kind, reason: String(err) };
	}
}

async function dispatch(
	epic: ForgeEpic,
	step: ForgeStep,
	userId: string
): Promise<StepOutcome> {
	const sprints = listSprints(epic.id);
	const tasks = listTasks(epic.id);
	const find = <T extends { id: string }>(rows: T[], id: string) => rows.find((r) => r.id === id);

	switch (step.kind) {
		case 'plan-sprint': {
			const sprint = find(sprints, step.sprintId);
			if (!sprint) return { step: step.kind, reason: 'sprint vanished' };
			const out = await runSprintPlan(epic, sprint, userId);
			// After the tree, never instead of it: the board is a view, so it is
			// written from rows that already exist rather than alongside them.
			if (out.ran) {
				mirrorSprint(epic, sprint, userId);
				for (const t of listTasks(epic.id).filter((t) => t.sprintId === sprint.id)) {
					mirrorTask(epic, sprint, t, userId);
				}
			}
			return { step: step.kind, reason: out.reason, detail: { ...out } };
		}
		case 'run-task': {
			const task = find(tasks, step.taskId);
			if (!task) return { step: step.kind, reason: 'task vanished' };
			return startTask(epic, task, userId);
		}
		case 'gate-task': {
			const task = find(tasks, step.taskId);
			if (!task) return { step: step.kind, reason: 'task vanished' };
			return gateTask(epic, task, userId);
		}
		// Both reach the same place: `close-sprint` marks a sprint for its gate and
		// runs it, and `gate-sprint` is what picks that up if a restart interrupted
		// it. One function, so the two cannot drift.
		case 'close-sprint':
		case 'gate-sprint': {
			const sprint = find(sprints, step.sprintId);
			if (!sprint) return { step: step.kind, reason: 'sprint vanished' };
			return closeSprint(epic, sprint, userId);
		}
		case 'close-epic':
			return closeEpic(epic, userId);
	}
}

/** Standing checks plus whatever this unit adds. */
const withStanding = (epic: ForgeEpic, own: ForgeCheck[] | null): ForgeCheck[] => [
	...(epic.standingChecks ?? []),
	...(own ?? [])
];

async function startTask(epic: ForgeEpic, task: ForgeTask, userId: string): Promise<StepOutcome> {
	// A retry starts from a clean clone, so the previous attempt's workspace goes
	// — otherwise a long epic leaves one full checkout per attempt on the volume.
	if (task.chatId) {
		const stale = getSession(task.chatId, userId);
		if (stale) destroySession(stale);
	}

	const session = await createSession({
		userId,
		repoUrl: epic.repoUrl,
		repoName: epic.repoName || epic.title,
		mode: 'implement',
		// What the last task landed, not the base — that is what an integration
		// branch is for.
		from: epic.integrationBranch
	});

	const job = startCodingTurn({
		session,
		userId,
		content: taskBrief(epic, task),
		webSearch: false,
		maxSteps: settings().maxStepsPerTask
	});
	setTaskState(task.id, 'running', { chatId: session.chatId, branch: session.workBranch });
	mirrorTaskState(epic, { ...task, state: 'running' }, userId, `attempt ${task.attempts + 1}`);

	/**
	 * `subscribeJob` replays history synchronously before it returns, so a job
	 * that is already finished fires this during the call — with `off` still in
	 * its temporal dead zone. The flag is what `sseResponse` uses for the same
	 * hazard, and it is the reason this is not three lines.
	 */
	let settled = false;
	// Initialised rather than merely declared, so the assignment below reads as a
	// reassignment: a bare `let` here is one prefer-const asks to make const, and
	// const is exactly what this cannot be.
	let off: (() => void) | undefined = undefined;
	const onChunk = (chunk: JobChunk) => {
		if (chunk.type !== 'done' && chunk.type !== 'error') return;
		if (settled) return;
		settled = true;
		off?.();
		// A turn cancelled because its build was paused or abandoned has nothing
		// to gate, and the halt has already put this task back to `planned`. The
		// row is re-read rather than trusted from the closure: `epic` is the
		// snapshot this step started from, and the whole reason for stopping is
		// that something changed since.
		if (getEpic(epic.id, userId)?.state !== 'running') return;
		// Whether it finished or fell over, what comes next is the gate. A turn
		// that errored may still have committed something worth judging, and a
		// gate is the only thing entitled to say it did not.
		setTaskState(task.id, 'gating');
	};
	off = subscribeJob(job, onChunk);
	if (settled) off();

	return {
		step: 'run-task',
		started: { chatId: session.chatId, jobId: job.id },
		detail: { taskId: task.id, attempt: task.attempts + 1 }
	};
}

/** The first message of a task's coding turn. */
function taskBrief(epic: ForgeEpic, task: ForgeTask): string {
	const lines = [
		`This is one task of a larger build: ${epic.title}.`,
		'',
		`## ${task.title}`,
		task.intent,
		task.acceptance ? `\nDone when: ${task.acceptance}` : ''
	];
	if (task.checks?.length) {
		lines.push(
			'',
			'It will be judged by these commands, which fail today and must pass when you are finished:',
			...task.checks.map((c) => `- \`${c.command}\``),
			'',
			'These were frozen before you started and cannot be changed. Do not edit them, and do not edit anything whose only purpose is to make them pass.'
		);
	} else {
		lines.push(
			'',
			`No automated check covers this one (${task.noCheckReason}), so a person will read the diff. Keep it small and obvious.`
		);
	}
	if (epic.standingChecks?.length) {
		lines.push(
			'',
			'The repository’s own checks also have to pass:',
			...epic.standingChecks.map((c) => `- \`${c.command}\``)
		);
	}

	// A retry carries what went wrong, fenced: a test can print anything,
	// including something addressed to whatever reads its output.
	const last = gateRunsFor(task.id).find((r) => !r.baseline && !r.passed);
	if (last?.results?.length) {
		lines.push('', `Your previous attempt failed its gate. ${gateReport(last.results)}`);
	}
	lines.push('', 'Commit your work. Do not push — that happens once the gate is green.');
	return lines.filter((l) => l !== '').join('\n');
}

async function gateTask(epic: ForgeEpic, task: ForgeTask, userId: string): Promise<StepOutcome> {
	const session = task.chatId ? getSession(task.chatId, userId) : null;
	if (!session) {
		return park(epic, task, userId, 'its workspace is gone, so nothing can be judged');
	}
	const attempt = task.attempts + 1;
	const { passed, results } = await runGate({
		checks: withStanding(epic, task.checks),
		workspaceRel: session.workspaceRel
	});
	recordGateRun({
		epicId: epic.id,
		scope: 'task',
		targetId: task.id,
		attempt,
		passed,
		results
	});

	if (!passed) {
		countAttempt(task.id);
		if (attempt >= settings().maxAttempts) {
			return park(epic, task, userId, 'it ran out of attempts against its gate');
		}
		// Back to planned: the next step starts a fresh attempt, and taskBrief
		// hands it the failure above.
		setTaskState(task.id, 'planned');
		mirrorTaskState(
			epic,
			{ ...task, state: 'planned' },
			userId,
			`gate failed on ${results.filter((r) => r.exitCode !== 0).map((r) => r.name).join(', ')}; retrying`
		);
		return {
			step: 'gate-task',
			detail: { taskId: task.id, passed: false, attempt, willRetry: true }
		};
	}

	const merged = await mergeIntoBranch(session.workspaceRel, epic.repoUrl, {
		target: epic.integrationBranch,
		source: session.workBranch,
		baseBranch: epic.baseBranch
	});
	if (!merged.ok) {
		countAttempt(task.id);
		// A conflict is a failure like any other, and parks the same way. The work
		// is still on its branch for a person to look at.
		return park(epic, task, userId, `its work would not merge: ${merged.output.slice(0, 300)}`);
	}

	const doc = writeTaskRecord(epic, task, userId, results.map((r) => r.name));
	setTaskState(task.id, 'done', { ...(doc ? { recordDocId: doc } : {}) });
	mirrorTaskState(
		epic,
		{ ...task, state: 'done' },
		userId,
		`merged into ${epic.integrationBranch} after ${attempt} attempt${attempt === 1 ? '' : 's'}`
	);
	destroySession(session);
	return { step: 'gate-task', detail: { taskId: task.id, passed: true, attempt } };
}

/** Stop working on a task, say so, and leave the epic free to carry on. */
function park(
	epic: ForgeEpic,
	task: ForgeTask,
	userId: string,
	reason: string
): StepOutcome {
	setTaskState(task.id, 'blocked');
	mirrorTaskState(epic, { ...task, state: 'blocked' }, userId, reason);
	notify({
		userId,
		kind: 'forge-blocked',
		title: `"${task.title}" is stuck`,
		body: `${epic.title}: ${reason}`,
		// No link until /forge exists in G4 — a notification pointing at a page
		// that answers 404 is worse than one that simply says what happened.
		entityId: task.id
	});
	return { step: 'gate-task', reason, detail: { taskId: task.id, blocked: true } };
}

/** The narrative of one task, filed under its sprint's record. */
function writeTaskRecord(
	epic: ForgeEpic,
	task: ForgeTask,
	userId: string,
	checkNames: string[]
): string | null {
	const sprint = listSprints(epic.id).find((s) => s.id === task.sprintId);
	// Only once the sprint has a record to hang off. Before that the task record
	// would be a root, and a root per task is exactly the cost the tree exists to
	// avoid — the sprint review picks these up when it writes its own.
	if (!sprint?.recordDocId) return null;
	const doc = saveDoc({
		title: `${task.title}`,
		body: [
			task.intent,
			task.acceptance ? `\n**Done when:** ${task.acceptance}` : '',
			`\nLanded on \`${epic.integrationBranch}\` from \`${task.branch}\` after ${task.attempts + 1} attempt${task.attempts ? 's' : ''}.`,
			checkNames.length ? `\nChecked by: ${checkNames.join(', ')}.` : '',
			task.noCheckReason ? `\nNo automated check: ${task.noCheckReason}.` : ''
		]
			.filter(Boolean)
			.join('\n'),
		author: 'agent',
		ownerId: userId,
		parentId: sprint.recordDocId
	});
	return doc.id;
}

async function closeSprint(
	epic: ForgeEpic,
	sprint: ForgeSprint,
	userId: string
): Promise<StepOutcome> {
	setSprintState(sprint.id, 'gating');
	const attempt = sprint.attempts + 1;
	const { passed, results } = await withWorkspace(
		epic.repoUrl,
		epic.integrationBranch,
		(ws) =>
			runGate({
				checks: withStanding(epic, epic.gateChecks),
				workspaceRel: ws.workspaceRel
			})
	);
	recordGateRun({
		epicId: epic.id,
		scope: 'sprint',
		targetId: sprint.id,
		attempt,
		passed,
		results
	});

	if (!passed) {
		countSprintAttempt(sprint.id);
		const failed = results.filter((r) => r.exitCode !== 0).map((r) => r.name);
		if (attempt >= settings().maxAttempts) {
			setSprintState(sprint.id, 'blocked');
			setEpicState(epic.id, 'blocked', `sprint "${sprint.title}" cannot pass its gate`);
			notify({
				userId,
				kind: 'forge-blocked',
				title: `"${epic.title}" has stopped`,
				body: `Sprint "${sprint.title}" failed its gate on ${failed.join(', ') || 'every check'}.`,
				entityId: epic.id
			});
			return { step: 'close-sprint', reason: 'the sprint gate failed', detail: { failed } };
		}
		// Back to running. Nothing is left to do in it, so the next step comes
		// straight back here — which is the retry.
		setSprintState(sprint.id, 'running');
		return { step: 'close-sprint', detail: { sprintId: sprint.id, passed: false, failed } };
	}

	const review = await runSprintReview(epic, sprint, userId);
	setSprintState(sprint.id, 'done');
	return {
		step: 'close-sprint',
		detail: { sprintId: sprint.id, passed: true, reviewed: review.ran }
	};
}

async function closeEpic(epic: ForgeEpic, userId: string): Promise<StepOutcome> {
	const result = await withWorkspace(epic.repoUrl, epic.integrationBranch, async (ws) => {
		const gate = await runGate({
			checks: withStanding(epic, epic.gateChecks),
			workspaceRel: ws.workspaceRel
		});
		if (!gate.passed) return { gate, pr: null as string | null, prError: '' };

		// openPullRequest pushes whatever is checked out, so the integration
		// branch has to be it — the clone left us on a work branch cut from it.
		await getExecutor().exec(
			`git checkout -B ${shellQuote(epic.integrationBranch)} ${shellQuote(`origin/${epic.integrationBranch}`)}`,
			{ cwdRel: ws.workspaceRel, timeoutMs: 60_000 }
		);
		try {
			const pr = await openPullRequest(
				{
					repoUrl: epic.repoUrl,
					workspaceRel: ws.workspaceRel,
					baseBranch: epic.baseBranch,
					workBranch: epic.integrationBranch
				},
				{
					title: epic.title,
					body: [
						epic.brief,
						'',
						...(epic.acceptance ?? []).map((a) => `- [ ] ${a}`),
						'',
						'Built by Forge. Every task on this branch passed the repository’s checks plus its own before it landed.'
					].join('\n')
				}
			);
			return { gate, pr: pr.url, prError: '' };
		} catch (err) {
			// The work is done whether or not a pull request could be opened — a
			// local remote has nowhere to open one, and that is not a failed epic.
			return { gate, pr: null, prError: scrubSecrets(String(err)).slice(0, 300) };
		}
	});

	if (!result.gate.passed) {
		const failed = result.gate.results.filter((r) => r.exitCode !== 0).map((r) => r.name);
		recordGateRun({
			epicId: epic.id,
			scope: 'epic',
			targetId: epic.id,
			passed: false,
			results: result.gate.results
		});
		setEpicState(epic.id, 'blocked', `the final gate failed on ${failed.join(', ')}`);
		return { step: 'close-epic', reason: 'the final gate failed', detail: { failed } };
	}

	recordGateRun({
		epicId: epic.id,
		scope: 'epic',
		targetId: epic.id,
		passed: true,
		results: result.gate.results
	});
	setEpicState(epic.id, 'done', result.pr ? `opened ${result.pr}` : result.prError);
	notify({
		userId,
		kind: 'forge-blocked',
		title: `"${epic.title}" is finished`,
		body: result.pr
			? `Every sprint passed. The pull request is open: ${result.pr}`
			: `Every sprint passed. It is on ${epic.integrationBranch}; no pull request was opened (${result.prError || 'not a GitHub remote'}).`,
		entityId: epic.id
	});
	return { step: 'close-epic', detail: { pr: result.pr, prError: result.prError } };
}
