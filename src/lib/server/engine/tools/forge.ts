import type { LoopTool } from '../loop';
import type { ForgeCheck } from '$lib/server/db/schema';
import { getEpic, listSprints, listTasks, type ForgeEpic } from '$lib/server/forge';

/**
 * What a Forge planning run may read and write.
 *
 * Deliberately absent from `builtinDescriptors()` and never passed through
 * `applyToolPolicy`, which is the same treatment the coding sub-agent's toolset
 * gets. The rule `TOOL_TASKS` states is that a task belongs there iff it
 * consults the policy, and `registry.test.ts` enforces it — listing these would
 * mean adding three task names to that constant and handing an admin a switch
 * that turns off `forge_charter_write` and breaks the charter run with nothing
 * to say why. The cost, stated plainly: an admin who disables `grep_files`
 * still has it inside a forge run, exactly as the sub-agent already behaves.
 *
 * The harder boundary is what these may write. `docs/FORGE.md` puts the whole
 * safety argument on checks a run cannot edit, so **nothing here touches
 * `standingChecks`**. `forge_charter_write` proposes; `approveEpic` is the only
 * writer, and it refuses a second approval.
 */

/** One proposal a charter run hands back. None of it is applied by the tool. */
export interface CharterProposal {
	sprints: { title: string; goal: string }[];
	standingChecks: ForgeCheck[];
	gateChecks: ForgeCheck[];
	acceptance: string[];
}

/** One proposal a sprint run hands back, before the baseline gate sees it. */
export interface TaskProposal {
	title: string;
	intent: string;
	acceptance: string;
	checks: ForgeCheck[];
	noCheckReason: string;
}

const MAX_SPRINTS = 12;
const MAX_TASKS = 20;
const MAX_CHECKS = 8;
/** A command longer than this is a script, and a script belongs in the repo. */
const MAX_COMMAND = 400;

const text = (v: unknown, max = 200): string =>
	typeof v === 'string' ? v.trim().slice(0, max) : '';

/**
 * Read a check out of model output.
 *
 * `timeoutMs` is deliberately not taken from the model: a check that sets its
 * own deadline can set it to nothing, and the gate treats a timeout as a
 * failure. The run picks it.
 */
export function readChecks(raw: unknown, timeoutMs = 0): ForgeCheck[] {
	if (!Array.isArray(raw)) return [];
	const out: ForgeCheck[] = [];
	for (const entry of raw.slice(0, MAX_CHECKS)) {
		if (!entry || typeof entry !== 'object') continue;
		const row = entry as Record<string, unknown>;
		const command = text(row.command, MAX_COMMAND);
		if (!command) continue;
		out.push({ name: text(row.name, 60) || command.slice(0, 60), command, timeoutMs });
	}
	return out;
}

export function readTasks(raw: unknown): TaskProposal[] {
	if (!Array.isArray(raw)) return [];
	const out: TaskProposal[] = [];
	for (const entry of raw.slice(0, MAX_TASKS)) {
		if (!entry || typeof entry !== 'object') continue;
		const row = entry as Record<string, unknown>;
		const title = text(row.title, 120);
		if (!title) continue;
		out.push({
			title,
			intent: text(row.intent, 2_000),
			acceptance: text(row.acceptance, 1_000),
			checks: readChecks(row.checks),
			noCheckReason: text(row.noCheckReason, 200)
		});
	}
	return out;
}

/** The epic as an agent reads it: where the build has got to, in one block. */
export function forgeTreeText(epic: ForgeEpic): string {
	const sprints = listSprints(epic.id);
	const tasks = listTasks(epic.id);
	const lines = [
		`# ${epic.title}`,
		`state: ${epic.state}${epic.stateReason ? ` — ${epic.stateReason}` : ''}`,
		`repo: ${epic.repoName || epic.repoUrl} · base ${epic.baseBranch} · integration ${epic.integrationBranch}`,
		epic.brief ? `\nBrief:\n${epic.brief}` : ''
	];
	if (epic.acceptance?.length) {
		lines.push('\nAcceptance:', ...epic.acceptance.map((a) => `- ${a}`));
	}
	for (const sprint of sprints) {
		lines.push(`\n## ${sprint.position + 1}. ${sprint.title} [${sprint.state}]`);
		if (sprint.goal) lines.push(`goal: ${sprint.goal}`);
		const mine = tasks.filter((t) => t.sprintId === sprint.id);
		if (!mine.length) {
			lines.push('(not planned yet)');
			continue;
		}
		for (const t of mine) {
			const checks = t.checks?.length
				? t.checks.map((c) => c.name).join(', ')
				: `no check — ${t.noCheckReason || 'unstated'}`;
			lines.push(
				`- [${t.state}] ${t.title} (${t.attempts} attempt${t.attempts === 1 ? '' : 's'}) — ${checks}`
			);
		}
	}
	return lines.filter((l) => l !== '').join('\n');
}

export interface CharterSink {
	(proposal: CharterProposal): void;
}

/**
 * The charter run's one write.
 *
 * It hands the proposal to the run rather than to the database: the run decides
 * what to do with it, and an epic is never left half-planned by a tool call
 * that happened to be the last thing before a timeout.
 */
export function charterTools(sink: CharterSink): LoopTool[] {
	return [
		{
			def: {
				name: 'forge_charter_write',
				description:
					'Record the structure of this build: its sprints in order, the checks every task will be held to, ' +
					'the slower checks worth running only at a sprint boundary, and how somebody would know the whole ' +
					'thing worked. Call this once, at the end, after your written charter. You are proposing — a person ' +
					'confirms the checks before anything runs, and nothing can change them afterwards.',
				parameters: {
					type: 'object',
					properties: {
						sprints: {
							type: 'array',
							description: 'Stages in order. Each leaves the repository working.',
							items: {
								type: 'object',
								properties: { title: { type: 'string' }, goal: { type: 'string' } },
								required: ['title', 'goal']
							}
						},
						standingChecks: {
							type: 'array',
							description: 'Commands run at every task gate, taken from what the repo already uses.',
							items: {
								type: 'object',
								properties: { name: { type: 'string' }, command: { type: 'string' } },
								required: ['name', 'command']
							}
						},
						gateChecks: {
							type: 'array',
							description: 'Slower commands, run only when a sprint closes.',
							items: {
								type: 'object',
								properties: { name: { type: 'string' }, command: { type: 'string' } },
								required: ['name', 'command']
							}
						},
						acceptance: {
							type: 'array',
							description: 'How a person tells the epic as a whole is done.',
							items: { type: 'string' }
						}
					},
					required: ['sprints', 'standingChecks']
				}
			},
			describe: (a) => `${Array.isArray(a.sprints) ? a.sprints.length : 0} sprints`,
			execute: async (a) => {
				const sprints = (Array.isArray(a.sprints) ? a.sprints : [])
					.slice(0, MAX_SPRINTS)
					.map((raw) => {
						const row = (raw ?? {}) as Record<string, unknown>;
						return { title: text(row.title, 120), goal: text(row.goal, 500) };
					})
					.filter((s) => s.title);
				if (!sprints.length) throw new Error('At least one sprint is required.');
				const standingChecks = readChecks(a.standingChecks);
				if (!standingChecks.length) {
					throw new Error(
						'At least one standing check is required — read package.json or the CI workflow and propose what this repository already runs.'
					);
				}
				sink({
					sprints,
					standingChecks,
					gateChecks: readChecks(a.gateChecks),
					acceptance: (Array.isArray(a.acceptance) ? a.acceptance : [])
						.map((v) => text(v, 200))
						.filter(Boolean)
						.slice(0, 20)
				});
				return `Recorded ${sprints.length} sprint${sprints.length === 1 ? '' : 's'} and ${standingChecks.length} standing check${standingChecks.length === 1 ? '' : 's'}. Now write the charter itself as your reply.`;
			}
		}
	];
}

/** Read-only context for any forge run: where the build has got to. */
export function forgeReadTools(epicId: string, userId: string): LoopTool[] {
	return [
		{
			parallelSafe: true,
			lookup: true,
			def: {
				name: 'forge_read',
				description:
					'Read this build: its brief, its acceptance list, its sprints in order and the state of every task in them.',
				parameters: { type: 'object', properties: {} }
			},
			describe: () => 'the epic',
			execute: async () => {
				// Scoped to the acting user like every other read in this codebase:
				// "not yours" has to be indistinguishable from "does not exist".
				const epic = getEpic(epicId, userId);
				if (!epic) throw new Error('No such epic.');
				return forgeTreeText(epic);
			}
		}
	];
}
