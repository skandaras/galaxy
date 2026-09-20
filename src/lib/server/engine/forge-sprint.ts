import {
	openTask,
	recordGateRun,
	setSprintState,
	type ForgeEpic,
	type ForgeSprint
} from '$lib/server/forge';
import { emitEvent } from './events';
import { extractJson } from './json';
import { forgeSystemPrompt, runHeadless, withWorkspace } from './forge-agent';
import { forgeReadTools, forgeTreeText, readTasks, type TaskProposal } from './tools/forge';
import { readOnlyCodingTools } from './coding/tools';
import { baselineIsRed, runGate, vacuousChecks, DEFAULT_CHECK_TIMEOUT_MS } from './forge-gate';

/**
 * Turning one sprint of a charter into tasks, and proving their checks can fail.
 *
 * Planned at the start of the sprint rather than up front, because planning
 * sprint four against a repository that sprint one has not built yet produces
 * tasks that will be rewritten by the time anything reaches them.
 *
 * The baseline is the half that matters. A check is frozen on the task before
 * any code exists, so the run that writes the work cannot edit the commands it
 * is judged by — and this proves those commands were capable of failing in the
 * first place. `true`, `echo ok` and naming a test that was already green all
 * pass here, before a line is written, and all three are refused.
 */

const SPRINT_MAX_STEPS = 20;

export interface SprintPlanOutcome {
	ran: boolean;
	reason?: string;
	tasks?: number;
	/** Tasks whose proposed checks passed before the work and were refused. */
	vacuous?: number;
	/** Tasks opened with no check at all, which the sprint review must read. */
	uncheckable?: number;
}

export async function runSprintPlan(
	epic: ForgeEpic,
	sprint: ForgeSprint,
	userId: string
): Promise<SprintPlanOutcome> {
	const startedAt = Date.now();
	setSprintState(sprint.id, 'planning');
	try {
		const outcome = await withWorkspace(epic.repoUrl, epic.integrationBranch, async (ws) => {
			const tools = [
				...readOnlyCodingTools({
					workspaceRel: ws.workspaceRel,
					mode: 'plan',
					repoUrl: epic.repoUrl,
					baseBranch: ws.baseBranch,
					workBranch: ws.workBranch
				}),
				...forgeReadTools(epic.id, userId)
			];
			const system = forgeSystemPrompt('forge-sprint', ws);
			const ask = (extra = '') =>
				runHeadless({
					userId,
					task: 'forge-sprint',
					epicId: epic.id,
					system,
					user: [
						forgeTreeText(epic),
						'',
						`Plan sprint ${sprint.position + 1}: ${sprint.title}`,
						sprint.goal ? `Its goal: ${sprint.goal}` : '',
						extra
					]
						.filter(Boolean)
						.join('\n'),
					tools,
					maxIterations: SPRINT_MAX_STEPS
				});

			let proposals = parse((await ask()).text);
			if (!proposals.length) return { ran: false as const, reason: 'no tasks were proposed' };

			let baselines = await baselineAll(proposals, ws.workspaceRel);
			const failedFirst = baselines.filter((b) => b.vacuous).length;

			// One retry round for every vacuous check at once, rather than one call
			// per task: a second chance is worth having and a third is a planner
			// that has not understood the rule.
			if (failedFirst) {
				const retry = parse(
					(
						await ask(
							[
								'',
								'These checks were run against the repository as it stands and they PASSED, which means they do not describe any work:',
								...baselines
									.filter((b) => b.vacuous)
									.map((b) => `- ${b.proposal.title}: ${b.passing.join(', ')}`),
								'',
								'Propose the whole sprint again. For those tasks give a command that fails today — a test file that does not exist, a script that is not wired up, a build that currently breaks. Where the work genuinely has no such command, set noCheckReason and leave checks empty.'
							].join('\n')
						)
					).text
				);
				if (retry.length) {
					proposals = retry;
					baselines = await baselineAll(proposals, ws.workspaceRel);
				}
			}

			let uncheckable = 0;
			for (const [i, b] of baselines.entries()) {
				// A check that could not fail is not carried onto the task. What is
				// carried is the admission that there is no check, which is what the
				// sprint review is told to read by hand.
				const keep = b.vacuous ? [] : b.proposal.checks;
				const reason = keep.length
					? ''
					: b.proposal.noCheckReason ||
						(b.vacuous
							? `the planner could not express a check that fails first (it proposed: ${b.passing.join(', ')})`
							: 'no check was proposed');
				if (!keep.length) uncheckable += 1;
				const task = openTask({
					epicId: epic.id,
					sprintId: sprint.id,
					title: b.proposal.title,
					intent: b.proposal.intent,
					acceptance: b.proposal.acceptance,
					checks: keep,
					noCheckReason: reason,
					position: i
				});
				// Evidence, kept: the baseline is the proof these checks were once
				// capable of failing, and a month later that is the only record of it.
				if (b.results.length) {
					recordGateRun({
						epicId: epic.id,
						scope: 'task',
						targetId: task.id,
						baseline: true,
						passed: !b.vacuous,
						results: b.results
					});
				}
			}

			return {
				ran: true as const,
				tasks: baselines.length,
				vacuous: failedFirst,
				uncheckable
			};
		});

		setSprintState(sprint.id, outcome.ran ? 'running' : 'outlined');
		emitEvent({
			userId,
			task: 'forge-sprint',
			type: 'job',
			name: 'forge.sprint-plan',
			status: outcome.ran ? 'ok' : 'error',
			durationMs: Date.now() - startedAt,
			detail: { epicId: epic.id, sprintId: sprint.id, ...outcome }
		});
		return outcome;
	} catch (err) {
		// Back to outlined, so the step can simply be asked for again.
		setSprintState(sprint.id, 'outlined');
		emitEvent({
			userId,
			task: 'forge-sprint',
			type: 'job',
			name: 'forge.sprint-plan',
			status: 'error',
			durationMs: Date.now() - startedAt,
			detail: { epicId: epic.id, sprintId: sprint.id, reason: String(err).slice(0, 500) }
		});
		return { ran: false, reason: String(err) };
	}
}

/**
 * Read the proposal out of a reply.
 *
 * An object with the array inside it, never a bare array: `extractJson` spans
 * the outermost braces, so a top-level array either fails to parse or quietly
 * returns its single element as though it were the whole answer.
 */
function parse(text: string): TaskProposal[] {
	const parsed = extractJson(text);
	return parsed ? readTasks(parsed.tasks) : [];
}

interface Baseline {
	proposal: TaskProposal;
	/** Checks that passed before any work — the ones that make it vacuous. */
	passing: string[];
	vacuous: boolean;
	results: Awaited<ReturnType<typeof runGate>>['results'];
}

async function baselineAll(proposals: TaskProposal[], workspaceRel: string): Promise<Baseline[]> {
	const out: Baseline[] = [];
	for (const proposal of proposals) {
		if (!proposal.checks.length) {
			out.push({ proposal, passing: [], vacuous: false, results: [] });
			continue;
		}
		const checks = proposal.checks.map((c) => ({ ...c, timeoutMs: DEFAULT_CHECK_TIMEOUT_MS }));
		const { results } = await runGate({ checks, workspaceRel });
		out.push({
			proposal: { ...proposal, checks },
			passing: vacuousChecks(results),
			vacuous: !baselineIsRed(results),
			results
		});
	}
	return out;
}
