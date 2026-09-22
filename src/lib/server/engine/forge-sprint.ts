import {
	openTask,
	recordGateRun,
	setSprintState,
	type ForgeEpic,
	type ForgeSprint
} from '$lib/server/forge';
import type { ForgeCheck } from '$lib/server/db/schema';
import { emitEvent } from './events';
import { extractJson } from './json';
import { forgeSystemPrompt, runHeadless, withWorkspace } from './forge-agent';
import { forgeReadTools, forgeTreeText, readTasks, type TaskProposal } from './tools/forge';
import { readOnlyCodingTools } from './coding/tools';
import {
	baselineIsRed,
	isRedCheck,
	runGate,
	unrunnableChecks,
	vacuousChecks,
	DEFAULT_CHECK_TIMEOUT_MS
} from './forge-gate';

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

			const first = parse((await ask()).text);
			let proposals = first.tasks;
			if (!proposals.length) {
				return { ran: false as const, reason: `no tasks were proposed: ${first.shape}` };
			}

			let baselines = await baselineAll(proposals, ws.workspaceRel);
			const failedFirst = baselines.filter((b) => b.vacuous).length;

			// One retry round for every refused check at once, rather than one call
			// per task: a second chance is worth having and a third is a planner
			// that has not understood the rule.
			if (failedFirst) {
				const passed = baselines.filter((b) => b.passing.length);
				const absent = baselines.filter((b) => b.unrunnable.length);
				const retry = parse(
					(
						await ask(
							[
								'',
								...(passed.length
									? [
											'These checks were run against the repository as it stands and they PASSED, which means they do not describe any work:',
											...passed.map((b) => `- ${b.proposal.title}: ${b.passing.join(', ')}`),
											''
										]
									: []),
								// Named separately, because "it passed" and "the shell could
								// not find it" ask for opposite corrections and a planner told
								// the wrong one will make the wrong change.
								...(absent.length
									? [
											'These could not be run at all — the shell found no such command. A check is a command, never an instruction addressed to a person:',
											...absent.map((b) => `- ${b.proposal.title}: ${b.unrunnable.join(', ')}`),
											''
										]
									: []),
								'Propose the whole sprint again. For those tasks give a command that fails today — a test file that does not exist, a script that is not wired up, a build that currently breaks. Where the work genuinely has no such command, set noCheckReason and leave checks empty.'
							].join('\n')
						)
					).text
				);
				if (retry.tasks.length) {
					proposals = retry.tasks;
					baselines = await baselineAll(proposals, ws.workspaceRel);
				}
			}

			let uncheckable = 0;
			for (const [i, b] of baselines.entries()) {
				// A check that could not fail is not carried onto the task. What is
				// carried is the admission that there is no check, which is what the
				// sprint review is told to read by hand. The refusal is per check
				// rather than per task: a proposal is sent back as a whole when any
				// of it was vacuous, and after that one retry whatever was genuinely
				// red is still a contract worth holding the work to.
				const keep = b.keep;
				const reason = keep.length
					? ''
					: b.proposal.noCheckReason ||
						(b.unrunnable.length
							? `nothing could run the check it proposed (${b.unrunnable.join(', ')})`
							: b.passing.length
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
 * Read the proposal out of a reply, and say what was wrong when there is none.
 *
 * An object with the array inside it, never a bare array: `extractJson` spans
 * the outermost braces, so a top-level array either fails to parse or quietly
 * returns its single element as though it were the whole answer.
 *
 * `shape` names the failure without quoting the reply. A planner that produces
 * nothing used to file `no tasks were proposed` and no more, which is the same
 * sentence whether the model wrote prose instead of JSON, used a different key,
 * or returned entries with no title — three faults wanting three different
 * corrections. The reply itself stays out of it: a sprint plan can quote the
 * brief back, and `forge-privacy.test.ts` holds the Observatory to counts and
 * ids rather than to what somebody is building.
 */
function parse(text: string): { tasks: TaskProposal[]; shape: string } {
	const parsed = extractJson(text);
	if (!parsed) {
		const shape = text.trim() ? 'the reply held no JSON object' : 'the reply was empty';
		return { tasks: [], shape };
	}
	if (!Array.isArray(parsed.tasks)) {
		return { tasks: [], shape: 'the JSON had no tasks array' };
	}
	const tasks = readTasks(parsed.tasks);
	return { tasks, shape: tasks.length ? '' : 'every entry in the tasks array was unusable' };
}

interface Baseline {
	proposal: TaskProposal;
	/** Checks that passed before any work — the ones that make it vacuous. */
	passing: string[];
	/** Checks nothing could run, which are red for ever and prove nothing. */
	unrunnable: string[];
	/**
	 * The ones that ran and failed, which are the ones worth freezing.
	 *
	 * Separate from `vacuous` because the two answer different questions. A set
	 * with one bad check in it should send the planner back for a better
	 * proposal, and that is what `vacuous` decides. What to keep afterwards is
	 * per check: a task offering `npx vitest run tests/new.test.ts` alongside
	 * `true` used to fail the set and lose both, and open with no gate at all.
	 */
	keep: ForgeCheck[];
	vacuous: boolean;
	results: Awaited<ReturnType<typeof runGate>>['results'];
}

async function baselineAll(proposals: TaskProposal[], workspaceRel: string): Promise<Baseline[]> {
	const out: Baseline[] = [];
	for (const proposal of proposals) {
		if (!proposal.checks.length) {
			out.push({ proposal, passing: [], unrunnable: [], keep: [], vacuous: false, results: [] });
			continue;
		}
		const checks = proposal.checks.map((c) => ({ ...c, timeoutMs: DEFAULT_CHECK_TIMEOUT_MS }));
		const { results } = await runGate({ checks, workspaceRel });
		out.push({
			proposal: { ...proposal, checks },
			passing: vacuousChecks(results),
			unrunnable: unrunnableChecks(results),
			// By index rather than by name: `runGate` runs the checks in the order
			// it is given them and a model is free to name two of them the same.
			keep: checks.filter((_c, i) => isRedCheck(results[i])),
			vacuous: !baselineIsRed(results),
			results
		});
	}
	return out;
}
