import { and, eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { chats, settings } from '$lib/server/db/schema';
import { appendMessage, getChat } from '$lib/server/chats';
import { deleteSetting, getSetting, setSetting } from '$lib/server/settings';
import {
	addSubIssue,
	agentLabel,
	createIssue,
	ensureLabels,
	IVORY_AGENTS,
	labelSet,
	listOpenIssues,
	projectIssueNumber,
	projectLabel
} from './board';
import type { ShelfClient } from './github';
import { projectFromBrief } from './shelf';

/**
 * The planner's proposal, between the run that wrote it and the person who
 * decides on it.
 *
 * Held as a settings row keyed to the planner's chat, like a run's scope, and
 * deleted the moment it is approved or rejected. It is a draft of work nobody
 * has agreed to, not task state: nothing is on the board until approval, and
 * after approval the board is the only record.
 */

const PLAN_KEY = 'ivory-plan';

/** Agents a planned task may be for, plus `none` for work a person does. */
export const PLANNABLE_AGENTS = [...IVORY_AGENTS.filter((a) => a !== 'ivory-plan'), 'none'] as const;
export type PlannedAgent = (typeof PLANNABLE_AGENTS)[number];

export const MAX_PLANNED_TASKS = 15;

export interface PlannedTask {
	title: string;
	body: string;
	agent: PlannedAgent;
	rationale: string;
}

export interface Proposal {
	repo: string;
	slug: string;
	tasks: PlannedTask[];
	/** `ivory-plan + <model>`, carried into each issue it becomes. */
	proposedBy: string;
	at: number;
}

export class PlanError extends Error {
	constructor(
		message: string,
		readonly status = 400
	) {
		super(message);
		this.name = 'PlanError';
	}
}

/**
 * The tasks as submitted, or the list of what is wrong with them. Used on the
 * model's proposal and again on the owner's edited copy, since the approval
 * request is the one the issues are actually made from.
 */
export function validateTasks(raw: unknown): { tasks: PlannedTask[]; problems: string[] } {
	const problems: string[] = [];
	if (!Array.isArray(raw) || !raw.length) return { tasks: [], problems: ['At least one task is needed.'] };
	if (raw.length > MAX_PLANNED_TASKS) problems.push(`At most ${MAX_PLANNED_TASKS} tasks; split the plan.`);
	const tasks: PlannedTask[] = [];
	raw.slice(0, MAX_PLANNED_TASKS).forEach((t, i) => {
		const n = i + 1;
		const o = (t ?? {}) as Record<string, unknown>;
		const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
		const title = str(o.title);
		const body = str(o.body);
		const rationale = str(o.rationale);
		const agent = str(o.agent).replace(/^agent:/, '') || 'none';
		if (!title || title.length > 120) problems.push(`Task ${n}: a title of 1 to 120 characters is needed.`);
		if (!body || body.length > 4000) problems.push(`Task ${n}: a body of 1 to 4000 characters is needed.`);
		if (!rationale || rationale.length > 600) problems.push(`Task ${n}: a rationale of 1 to 600 characters is needed.`);
		if (!(PLANNABLE_AGENTS as readonly string[]).includes(agent)) {
			problems.push(`Task ${n}: agent must be one of ${PLANNABLE_AGENTS.join(', ')}.`);
		}
		tasks.push({ title, body, rationale, agent: agent as PlannedAgent });
	});
	return { tasks, problems };
}

export function storeProposal(chatId: string, proposal: Proposal): void {
	setSetting(PLAN_KEY, proposal, chatId);
}

export function getProposal(chatId: string): Proposal | null {
	return getSetting<Proposal | null>(PLAN_KEY, null, chatId);
}

/** This person's pending proposals for one project. Ownership is in the join, not a filter afterwards. */
export function listProposals(userId: string, repo: string, slug: string): { chatId: string; proposal: Proposal }[] {
	return db
		.select({ chatId: settings.scope, value: settings.value })
		.from(settings)
		.innerJoin(chats, eq(chats.id, settings.scope))
		.where(and(eq(settings.key, PLAN_KEY), eq(chats.userId, userId)))
		.all()
		.map((r) => ({ chatId: r.chatId, proposal: r.value as Proposal }))
		.filter((r) => r.proposal.repo === repo && r.proposal.slug === slug)
		.sort((a, b) => b.proposal.at - a.proposal.at);
}

function issueBody(task: PlannedTask, proposedBy: string): string {
	return [task.body, '', '---', `**Why:** ${task.rationale}`, '', `_Proposed by ${proposedBy} in Galaxy, approved by the owner._`].join(
		'\n'
	);
}

export interface ApprovalResult {
	created: { number: number; url: string; title: string }[];
	/** Set when some issues were created and the rest were not. */
	failed?: string;
}

/**
 * Put the approved tasks on the board.
 *
 * The proposal is removed before the first issue is created, so a second
 * click (or a second tab) finds nothing to approve rather than filing the
 * whole plan twice. If GitHub fails part way, the tasks not yet created go
 * back as the proposal, and the ones already created are reported.
 */
export async function approvePlan(
	client: ShelfClient,
	opts: { chatId: string; userId: string; tasks: unknown }
): Promise<ApprovalResult> {
	const chat = getChat(opts.chatId, opts.userId);
	if (!chat) throw new PlanError('No such plan', 404);
	const proposal = getProposal(chat.id);
	if (!proposal) throw new PlanError('This plan has already been approved or rejected.', 409);
	if (proposal.repo !== client.repo) {
		throw new PlanError(`This plan is for ${proposal.repo}, and the Shelf is now ${client.repo}.`, 409);
	}
	const { tasks, problems } = validateTasks(opts.tasks);
	if (problems.length) throw new PlanError(problems.join(' '));

	deleteSetting(PLAN_KEY, chat.id);
	const created: ApprovalResult['created'] = [];
	try {
		const brief = await client.file(`projects/${proposal.slug}/brief.md`, { fresh: true });
		if (brief === null) throw new PlanError(`The project ${proposal.slug} is no longer on the Shelf.`, 404);
		const project = projectFromBrief(proposal.slug, brief);
		const wanted = labelSet([project]).filter(
			(l) => l.name === projectLabel(project.slug) || tasks.some((t) => l.name === agentLabel(t.agent))
		);
		await ensureLabels(client, wanted);
		const parent = projectIssueNumber(project, await listOpenIssues(client, { fresh: true }), client.repo);

		for (const task of tasks) {
			const issue = await createIssue(client, {
				title: task.title,
				body: issueBody(task, proposal.proposedBy),
				labels: [projectLabel(project.slug), ...(task.agent === 'none' ? [] : [agentLabel(task.agent)])]
			});
			created.push({ number: issue.number, url: issue.url, title: issue.title });
			if (parent !== null) {
				// Best effort: sub-issues are a newer API, and a task outside the
				// hierarchy is still a task under the project label.
				await addSubIssue(client, parent, issue.id).catch(() => undefined);
			}
		}
	} catch (err) {
		const rest = tasks.slice(created.length);
		if (rest.length) storeProposal(chat.id, { ...proposal, tasks: rest, at: Date.now() });
		if (!created.length) throw err;
		const failed = err instanceof Error ? err.message : String(err);
		recordDecision(chat.id, created, failed);
		return { created, failed };
	}
	recordDecision(chat.id, created);
	return { created };
}

function recordDecision(chatId: string, created: ApprovalResult['created'], failed?: string): void {
	const lines = [
		`Plan approved. ${created.length} task${created.length === 1 ? '' : 's'} added to the board:`,
		...created.map((c) => `- [#${c.number} ${c.title}](${c.url})`)
	];
	if (failed) lines.push('', `The rest were not created (${failed}) and are still waiting on the project page.`);
	appendMessage(chatId, { role: 'assistant', content: lines.join('\n') });
}

/** Drop the proposal. Nothing reaches GitHub. */
export function rejectPlan(opts: { chatId: string; userId: string }): void {
	const chat = getChat(opts.chatId, opts.userId);
	if (!chat) throw new PlanError('No such plan', 404);
	if (!getProposal(chat.id)) throw new PlanError('This plan has already been approved or rejected.', 409);
	deleteSetting(PLAN_KEY, chat.id);
	appendMessage(chat.id, { role: 'assistant', content: 'Plan rejected. Nothing was added to the board.' });
}
