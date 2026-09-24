import { beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '$lib/server/db';
import { createChat, deleteChat, getMessages } from '$lib/server/chats';
import { subscribeJob, type LiveJob } from '$lib/server/engine/jobs';
import type { ModelChoice } from '$lib/server/providers/registry';
import type { ChatRequest, StreamEvent } from '$lib/server/providers/types';
import { fakeGithub, SAMPLE_BRIEF } from './github-fixture';
import { approvePlan, getProposal, listProposals, rejectPlan, storeProposal, validateTasks, type Proposal } from './plan';
import { startPlanRun } from './run';
import { readStatus } from './status';
import { RECENT_ISSUE_MS } from './board';
import { shelfIndex, shelfProjectView } from './view';

beforeAll(() => {
	runMigrations();
});

const BRIEF = SAMPLE_BRIEF.replace('slug: bees-and-queues', 'slug: bees');

const TASKS = [
	{
		title: 'Check whether load balancing already describes waggle dances',
		body: 'Search operations research for honeybee allocation models.',
		agent: 'ivory-read',
		rationale: 'The kill criterion: the idea may already be known.'
	},
	{
		title: 'Decide what counts as a load in a colony',
		body: 'Write down the mapping before any claim is drafted.',
		agent: 'none',
		rationale: 'The mapping needs a person.'
	}
];

function withPlan(userId = 'planner-user') {
	const gh = fakeGithub();
	gh.files.set('projects/bees/brief.md', BRIEF);
	const parent = gh.addIssue({ title: 'Project', labels: ['project:bees', 'discipline:entomology'] });
	const chat = createChat({ userId, title: 'Ivory plan', agentTask: 'ivory-plan' });
	const proposal: Proposal = {
		repo: gh.repo,
		slug: 'bees',
		tasks: validateTasks(TASKS).tasks,
		proposedBy: 'ivory-plan + mock/big',
		at: Date.now()
	};
	storeProposal(chat.id, proposal);
	return { gh, chatId: chat.id, parent, userId };
}

describe('validateTasks', () => {
	it('accepts a plan and names every problem with a bad one', () => {
		expect(validateTasks(TASKS).problems).toEqual([]);
		expect(validateTasks([{ title: '', body: 'x', agent: 'ivory-plan', rationale: '' }]).problems).toEqual([
			'Task 1: a title of 1 to 120 characters is needed.',
			'Task 1: a rationale of 1 to 600 characters is needed.',
			'Task 1: agent must be one of ivory-read, ivory-synthesise, ivory-redteam, none.'
		]);
		expect(validateTasks([]).problems).toEqual(['At least one task is needed.']);
	});
});

describe('approving a plan', () => {
	it('creates correctly labelled issues under the project, once', async () => {
		const { gh, chatId, parent, userId } = withPlan();
		const result = await approvePlan(gh.client, { chatId, userId, tasks: TASKS });

		const made = gh.issues.filter((i) => i.number !== parent.number);
		expect(made.map((i) => [i.title, i.labels])).toEqual([
			[TASKS[0].title, ['project:bees', 'agent:ivory-read']],
			[TASKS[1].title, ['project:bees']]
		]);
		expect(made[0].body).toContain('**Why:** The kill criterion');
		expect(made[0].body).toContain('Proposed by ivory-plan + mock/big');
		expect(gh.subIssues).toEqual(made.map((i) => ({ parent: parent.number, child: i.id })));
		expect(gh.labels.has('agent:ivory-read')).toBe(true);
		expect(result.created.map((c) => c.number)).toEqual(made.map((i) => i.number));
		expect(getMessages(chatId).at(-1)?.content).toMatch(/^Plan approved\. 2 tasks added/);
		expect(readStatus(parent.body)).toMatchObject({
			text: `Plan approved: 2 tasks filed. Next: #${made[0].number} ${TASKS[0].title}`,
			by: 'Galaxy'
		});

		// A second click finds nothing to approve.
		await expect(approvePlan(gh.client, { chatId, userId, tasks: TASKS })).rejects.toThrow(/already been approved/);
		expect(gh.issues).toHaveLength(3);
	});

	it("files the owner's edits, not the planner's original", async () => {
		const { gh, chatId, userId } = withPlan();
		await approvePlan(gh.client, { chatId, userId, tasks: [{ ...TASKS[0], title: 'Edited title' }] });
		expect(gh.issues.map((i) => i.title)).toEqual(['Project', 'Edited title']);
	});

	it('refuses an edited plan that breaks the rules, and keeps the proposal', async () => {
		const { gh, chatId, userId } = withPlan();
		await expect(
			approvePlan(gh.client, { chatId, userId, tasks: [{ ...TASKS[0], agent: 'ivory-plan' }] })
		).rejects.toThrow(/agent must be one of/);
		expect(getProposal(chatId)).not.toBeNull();
		expect(gh.issues).toHaveLength(1);
	});

	it("is not reachable from someone else's account", async () => {
		const { gh, chatId } = withPlan('owner-a');
		await expect(approvePlan(gh.client, { chatId, userId: 'owner-b', tasks: TASKS })).rejects.toThrow(/No such plan/);
		expect(() => rejectPlan({ chatId, userId: 'owner-b' })).toThrow(/No such plan/);
		expect(listProposals('owner-b', gh.repo, 'bees')).toEqual([]);
		expect(listProposals('owner-a', gh.repo, 'bees').map((p) => p.chatId)).toEqual([chatId]);
	});
});

describe('after approval', () => {
	it("shows the new tasks straight away, even while GitHub's list has not caught up", async () => {
		const gh = fakeGithub('owner/shelf', { lagging: true });
		gh.files.set('projects/bees/brief.md', BRIEF);
		gh.addIssue({ title: 'Project', labels: ['project:bees', 'discipline:entomology'] });
		const chat = createChat({ userId: 'lag', title: 'Ivory plan', agentTask: 'ivory-plan' });
		storeProposal(chat.id, { repo: gh.repo, slug: 'bees', tasks: validateTasks(TASKS).tasks, proposedBy: 'p', at: 1 });

		const { created } = await approvePlan(gh.client, { chatId: chat.id, userId: 'lag', tasks: TASKS });
		// What the page does next: reload, while GitHub still lists none of them.
		const view = await shelfProjectView(gh.client, 'bees');
		expect(view?.issues.map((i) => i.number)).toEqual(created.map((c) => c.number));
		expect((await shelfIndex(gh.client)).groups[0].projects[0].openTasks).toBe(2);
		expect(view?.issuesUrl).toBe(
			'https://github.com/owner/shelf/issues?q=is%3Aissue%20label%3A%22project%3Abees%22'
		);

		// Once GitHub has them, they are listed once, not twice.
		gh.settle();
		gh.clock.now += 61_000;
		expect((await shelfProjectView(gh.client, 'bees'))?.issues).toHaveLength(2);

		// And the stand-in lapses, so a task closed on GitHub does not linger.
		gh.issues.find((i) => i.number === created[0].number)!.state = 'closed';
		gh.clock.now += RECENT_ISSUE_MS;
		expect((await shelfProjectView(gh.client, 'bees'))?.issues.map((i) => i.number)).toEqual([created[1].number]);
	});
});

describe('a token that cannot label new issues', () => {
	const approveWith = async (labels: 'drop' | 'refuse') => {
		const gh = fakeGithub('owner/shelf', { labels });
		gh.files.set('projects/bees/brief.md', BRIEF);
		const chat = createChat({ userId: 'labels', title: 'Ivory plan', agentTask: 'ivory-plan' });
		storeProposal(chat.id, { repo: gh.repo, slug: 'bees', tasks: validateTasks(TASKS).tasks, proposedBy: 'p', at: 1 });
		const result = await approvePlan(gh.client, { chatId: chat.id, userId: 'labels', tasks: TASKS });
		return { gh, chatId: chat.id, result };
	};

	it('gets the labels on afterwards, so the tasks are still found', async () => {
		const { gh, result } = await approveWith('drop');
		expect(result.failed).toBeUndefined();
		const tasks = gh.issues.filter((i) => TASKS.some((t) => t.title === i.title));
		expect(tasks.map((i) => i.labels)).toEqual([['project:bees', 'agent:ivory-read'], ['project:bees']]);
		expect((await shelfProjectView(gh.client, 'bees'))?.issues).toHaveLength(2);
	});

	it('stops and says why when GitHub will not label at all, and files nothing twice', async () => {
		const { gh, chatId, result } = await approveWith('refuse');
		// The project issue Galaxy tried to make first, and the one task, both unlabelled.
		const tasks = gh.issues.filter((i) => TASKS.some((t) => t.title === i.title));
		expect(tasks).toHaveLength(1);
		expect(result.created.map((c) => c.number)).toEqual([tasks[0].number]);
		expect(result.failed).toMatch(/would not give it project:bees, agent:ivory-read.*Contents and Issues read\/write/);
		// The one not yet filed is still waiting for approval.
		expect(getProposal(chatId)?.tasks.map((t) => t.title)).toEqual([TASKS[1].title]);
	});
});

describe('approving a plan for a project with no project issue', () => {
	it('gives it one, and nests the tasks under it', async () => {
		const gh = fakeGithub();
		gh.files.set('projects/bees/brief.md', BRIEF);
		const chat = createChat({ userId: 'nest', title: 'Ivory plan', agentTask: 'ivory-plan' });
		storeProposal(chat.id, { repo: gh.repo, slug: 'bees', tasks: validateTasks(TASKS).tasks, proposedBy: 'p', at: 1 });
		await approvePlan(gh.client, { chatId: chat.id, userId: 'nest', tasks: TASKS });
		const project = gh.issues.find((i) => i.labels.includes('discipline:entomology'))!;
		const tasks = gh.issues.filter((i) => i !== project);
		expect(tasks).toHaveLength(2);
		expect(gh.subIssues).toEqual(tasks.map((t) => ({ parent: project.number, child: t.id })));
		expect(readStatus(project.body)?.text).toMatch(/^Plan approved: 2 tasks filed/);
	});
});

describe('rejecting a plan', () => {
	it('creates nothing and clears the proposal', async () => {
		const { gh, chatId, userId } = withPlan();
		expect(rejectPlan({ chatId, userId })).toEqual({ slug: 'bees' });
		expect(gh.requests.filter((r) => r.method !== 'GET')).toEqual([]);
		expect(getProposal(chatId)).toBeNull();
		await expect(approvePlan(gh.client, { chatId, userId, tasks: TASKS })).rejects.toThrow(/already been approved or rejected/);
		expect(gh.issues).toHaveLength(1);
	});
});

describe('deleting the planner chat', () => {
	it('takes the waiting proposal with it', () => {
		const { gh, chatId, userId } = withPlan('deleter');
		deleteChat(chatId, userId);
		expect(getProposal(chatId)).toBeNull();
		expect(listProposals(userId, gh.repo, 'bees')).toEqual([]);
	});
});

describe('the planner run', () => {
	it('holds no tool that writes to the board, and ends in a proposal rather than issues', async () => {
		const gh = fakeGithub();
		gh.files.set('projects/bees/brief.md', BRIEF);
		gh.addIssue({ title: 'Project', labels: ['project:bees', 'discipline:entomology'] });
		const offered: string[][] = [];
		let step = 0;
		const choice = {
			model: {
				id: 'm2',
				modelKey: 'mock/big',
				displayName: 'Mock Big',
				supportsTools: true,
				supportsVision: false,
				supportsReasoning: false,
				reasoningMode: 'auto',
				promptCostPerMTok: null,
				completionCostPerMTok: null
			},
			provider: {},
			adapter: {
				async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
					offered.push((req.tools ?? []).map((t) => t.name));
					if (step++ === 0) {
						yield { type: 'tool_calls', calls: [{ id: 'p1', name: 'propose_tasks', arguments: JSON.stringify({ tasks: TASKS }) }] };
						yield { type: 'done', finishReason: 'tool_calls' };
						return;
					}
					yield { type: 'text', delta: 'The plan tests prior art first. It is waiting on the project page.' };
					yield { type: 'done', finishReason: 'stop' };
				},
				complete: async () => ({ text: '', usage: null }),
				listModels: async () => []
			}
		} as unknown as ModelChoice;

		const { chatId, job } = await startPlanRun(
			{ slug: 'bees', userId: 'planner-run' },
			{ client: gh.client, choice, backup: null, paperSearch: async () => [] }
		);
		await new Promise<void>((resolve) => {
			const off = subscribeJob(job as LiveJob, (c) => {
				if (c.type === 'done' || c.type === 'error') {
					queueMicrotask(() => off());
					resolve();
				}
			});
		});

		for (const names of offered) {
			expect([...names].sort()).toEqual(['fetch_url', 'paper_search', 'propose_tasks', 'set_status', 'shelf_read']);
		}
		expect(gh.requests.filter((r) => r.method !== 'GET')).toEqual([]);
		expect(gh.comments).toEqual([]);
		expect(getProposal(chatId)).toMatchObject({ slug: 'bees', proposedBy: 'ivory-plan + mock/big' });
		expect(getProposal(chatId)?.tasks).toHaveLength(2);
		// The run was briefed with what is on the board already.
		expect(getMessages(chatId)[0].content).toContain('--- BEGIN OPEN TASKS ---');
	});
});
