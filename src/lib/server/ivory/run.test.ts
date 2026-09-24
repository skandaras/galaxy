import { beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, runMigrations } from '$lib/server/db';
import { events } from '$lib/server/db/schema';
import { seedSkills } from '$lib/server/bootstrap';
import { getMessages, listChats } from '$lib/server/chats';
import { setSkillEnabled } from '$lib/server/skills';
import { subscribeJob, type LiveJob } from '$lib/server/engine/jobs';
import type { ModelChoice } from '$lib/server/providers/registry';
import type { ChatRequest, StreamEvent } from '$lib/server/providers/types';
import { fakeGithub, GOOD_CLAIM, GOOD_NOTE, SAMPLE_BRIEF } from './github-fixture';
import { parseClaim } from './claims';
import { validateNote, WRITE_SOURCE_NOTE_SKILL } from './notes';
import { readStatus } from './status';
import { IvoryRunError, runScope, startTaskRun } from './run';

/**
 * The reader end to end: an issue on a fake board, a scripted model, and the
 * real loop, tools and scope in between.
 */

beforeAll(() => {
	runMigrations();
	seedSkills();
});

type Step = { tool: string; args: Record<string, unknown> } | { text: string } | { fail: string };

/** A model that plays `steps` in order, one per round-trip, and records what it was offered. */
function scripted(steps: Step[]) {
	const offered: string[][] = [];
	let i = 0;
	const choice = {
		model: {
			id: 'm1',
			modelKey: 'mock/one',
			displayName: 'Mock One',
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
				const step = steps[i] ?? { text: 'Done.' };
				// A failing step fails every retry of it, so the run ends in error.
				if ('fail' in step) throw new Error(step.fail);
				i++;
				if ('tool' in step) {
					yield { type: 'tool_calls', calls: [{ id: `c${i}`, name: step.tool, arguments: JSON.stringify(step.args) }] };
					yield { type: 'done', finishReason: 'tool_calls' };
					return;
				}
				yield { type: 'text', delta: step.text };
				yield { type: 'done', finishReason: 'stop' };
			},
			complete: async () => ({ text: '', usage: null }),
			listModels: async () => []
		}
	} as unknown as ModelChoice;
	return { choice, offered };
}

const finished = (job: LiveJob) =>
	new Promise<void>((resolve) => {
		const off = subscribeJob(job, (c) => {
			if (c.type === 'done' || c.type === 'error') {
				queueMicrotask(() => off());
				resolve();
			}
		});
	});

async function until(check: () => boolean) {
	for (let n = 0; n < 200 && !check(); n++) await new Promise((r) => setTimeout(r, 5));
}

const ABSTRACT = 'Seeley shows that dance duration scales with patch profitability across many colonies.';

function board() {
	const gh = fakeGithub();
	gh.files.set('projects/bees/brief.md', SAMPLE_BRIEF.replace('slug: bees-and-queues', 'slug: bees'));
	gh.files.set('projects/wasps/brief.md', 'not yours');
	gh.addIssue({ title: 'Project', labels: ['project:bees', 'discipline:entomology'] });
	const task = gh.addIssue({
		title: 'Read Seeley 1995',
		body: 'Read The Wisdom of the Hive and note how foragers are allocated.',
		labels: ['project:bees', 'agent:ivory-read']
	});
	return { gh, task };
}

describe('startTaskRun', () => {
	it('reads, writes a valid note, is refused outside its project, and comments on the issue', async () => {
		const { gh, task } = board();
		const { choice, offered } = scripted([
			{ tool: 'paper_search', args: { query: 'Seeley Wisdom of the Hive' } },
			{ tool: 'shelf_write', args: { path: 'projects/wasps/notes/N-001.md', content: GOOD_NOTE } },
			{ tool: 'shelf_write', args: { path: 'notes/N-002-seeley-1995.md', content: GOOD_NOTE } },
			{ tool: 'set_status', args: { summary: 'Seeley 1995 noted from its abstract. Next: find a full text.' } },
			{ text: 'Wrote notes/N-002-seeley-1995.md.' }
		]);
		const { chatId, job } = await startTaskRun(
			{ slug: 'bees', issueNumber: task.number, userId: 'reader-user' },
			{
				client: gh.client,
				choice,
				backup: null,
				paperSearch: async () => [
					{
						title: 'The Wisdom of the Hive',
						authors: ['Thomas D. Seeley'],
						year: 1995,
						doi: 'https://doi.org/10.4159/9780674043404',
						url: 'https://doi.org/10.4159/9780674043404',
						abstract: ABSTRACT,
						openAccess: false,
						oaUrl: null,
						pmcid: null,
						arxivId: null
					}
				]
			}
		);
		await finished(job);
		await until(() => gh.comments.length > 0 && gh.issues[0].body.includes('galaxy:status'));

		// The runner put the reader's status line on the project issue, signed.
		expect(readStatus(gh.issues[0].body)).toMatchObject({
			text: 'Seeley 1995 noted from its abstract. Next: find a full text.',
			by: 'ivory-read + mock/one'
		});

		// Exactly the brief's allowlist, on every round-trip.
		for (const names of offered) {
			expect([...names].sort()).toEqual(['fetch_url', 'paper_search', 'read_paper', 'set_status', 'shelf_read', 'shelf_write']);
		}

		// The one valid note landed, stamped, and it passes the template's checks.
		const note = gh.files.get('projects/bees/notes/N-002-seeley-1995.md')!;
		expect(validateNote(note, { project: 'bees' })).toEqual([]);
		expect(note).toContain('access: abstract-only');
		expect(note).toContain(`task: "https://github.com/owner/shelf/issues/${task.number}"`);
		expect(gh.files.has('projects/wasps/notes/N-001.md')).toBe(false);

		// The refusal is on record where the owner looks for failures.
		const refused = db
			.select()
			.from(events)
			.where(and(eq(events.chatId, chatId), eq(events.name, 'shelf_write'), eq(events.status, 'error')))
			.all();
		expect(refused).toHaveLength(1);
		expect(JSON.stringify(refused[0].detail)).toContain("another project's folder");

		// The runner, not the agent, reports back; the issue is left open.
		expect(gh.comments).toHaveLength(1);
		expect(gh.comments[0].issue).toBe(task.number);
		expect(gh.comments[0].body).toContain('**ivory-read** (`mock/one`) finished');
		expect(gh.comments[0].body).toContain('[notes/N-002-seeley-1995.md](https://github.com/owner/shelf/blob/main/projects/bees/notes/N-002-seeley-1995.md)');
		expect(gh.issues.find((i) => i.number === task.number)?.state).toBe('open');

		// The run is an ordinary chat that remembers its scope.
		expect(runScope(chatId)).toMatchObject({ task: 'ivory-read', slug: 'bees', issue: task.number });
		expect(getMessages(chatId).at(-1)?.content).toBe('Wrote notes/N-002-seeley-1995.md.');
	});

	it('writes no status line from a run that failed', async () => {
		const { gh, task } = board();
		const { choice } = scripted([
			{ tool: 'set_status', args: { summary: 'All done here.' } },
			{ fail: 'provider exploded' }
		]);
		const { job } = await startTaskRun(
			{ slug: 'bees', issueNumber: task.number, userId: 'reader-user' },
			{ client: gh.client, choice, backup: null, paperSearch: async () => [] }
		);
		await finished(job);
		await until(() => gh.comments.length > 0);
		expect(job.status).toBe('error');
		expect(gh.comments[0].body).toContain('did not finish this task');
		expect(gh.issues.some((i) => i.body.includes('galaxy:status'))).toBe(false);
	});

	it('comments that nothing was written when the reader writes nothing', async () => {
		const { gh, task } = board();
		const { choice } = scripted([{ text: 'The source could not be found.' }]);
		const { job } = await startTaskRun(
			{ slug: 'bees', issueNumber: task.number, userId: 'reader-user' },
			{ client: gh.client, choice, backup: null, paperSearch: async () => [] }
		);
		await finished(job);
		await until(() => gh.comments.length > 0);
		expect(gh.comments[0].body).toContain('No notes were written.');
	});

	it('will not read without its note method, and leaves no chat behind', async () => {
		const { gh, task } = board();
		const { choice } = scripted([]);
		setSkillEnabled(WRITE_SOURCE_NOTE_SKILL, false);
		try {
			await expect(
				startTaskRun({ slug: 'bees', issueNumber: task.number, userId: 'no-skill' }, { client: gh.client, choice, backup: null })
			).rejects.toThrow(/write-source-note skill is missing or switched off/);
		} finally {
			setSkillEnabled(WRITE_SOURCE_NOTE_SKILL, true);
		}
		expect(listChats('no-skill')).toEqual([]);
	});

	it('refuses an issue that is not a reading task of this project', async () => {
		const { gh } = board();
		const other = gh.addIssue({ title: 'Plan', labels: ['project:bees', 'agent:ivory-plan'] });
		const elsewhere = gh.addIssue({ title: 'Read', labels: ['project:wasps', 'agent:ivory-read'] });
		const { choice } = scripted([]);
		const deps = { client: gh.client, choice, backup: null };
		await expect(startTaskRun({ slug: 'bees', issueNumber: other.number, userId: 'u' }, deps)).rejects.toThrow(
			/not labelled for an agent Galaxy can run/
		);
		await expect(startTaskRun({ slug: 'bees', issueNumber: elsewhere.number, userId: 'u' }, deps)).rejects.toThrow(
			IvoryRunError
		);
		expect(gh.commits).toEqual([]);
	});
});

describe('the synthesiser and the red-team', () => {
	function shelfWithNotes() {
		const { gh } = board();
		gh.files.set('projects/bees/notes/N-002-seeley-1995.md', GOOD_NOTE);
		gh.files.set('templates/claim-mapping.md', '---\nid: C-001\n---\n# The Shelf copy of the claim template');
		return gh;
	}

	it('runs the synthesiser on its task: the claim template in its prompt, a draft claim on the Shelf', async () => {
		const gh = shelfWithNotes();
		const task = gh.addIssue({ title: 'Synthesise the dance notes', labels: ['project:bees', 'agent:ivory-synthesise'] });
		const { choice, offered } = scripted([
			{ tool: 'shelf_write', args: { path: 'claims/C-001.md', content: GOOD_CLAIM } },
			{ tool: 'set_status', args: { summary: 'C-001 drafted. Next: red-team it.' } },
			{ text: 'Wrote C-001.' }
		]);
		const seen: string[] = [];
		const wrapped = {
			...choice,
			adapter: {
				...choice.adapter,
				stream: (req: ChatRequest) => {
					seen.push(String(req.messages[0].content));
					return choice.adapter.stream(req as never);
				}
			}
		} as unknown as ModelChoice;
		const { job } = await startTaskRun(
			{ slug: 'bees', issueNumber: task.number, userId: 'synth' },
			{ client: gh.client, choice: wrapped, backup: null, paperSearch: async () => [] }
		);
		await finished(job);
		await until(() => gh.comments.length > 0);

		expect(seen[0]).toContain('The Shelf copy of the claim template');
		for (const names of offered) {
			expect([...names].sort()).toEqual(['paper_search', 'set_status', 'shelf_read', 'shelf_write']);
		}
		expect(parseClaim(gh.files.get('projects/bees/claims/C-001.md')!)).toMatchObject({
			status: 'draft',
			authoredBy: 'ivory-synthesise + mock/one'
		});
		expect(gh.comments[0].body).toContain('Claims written:');
		expect(gh.comments[0].body).toContain('status **draft**');
	});

	it('refuses a red-team on the author\'s model family before it starts', async () => {
		const gh = shelfWithNotes();
		gh.files.set('projects/bees/claims/C-001.md', GOOD_CLAIM.replace('z-ai/glm-5.3', 'mock/two'));
		const task = gh.addIssue({ title: 'Red-team C-001', labels: ['project:bees', 'agent:ivory-redteam'] });
		const { choice } = scripted([]);
		await expect(
			startTaskRun({ slug: 'bees', issueNumber: task.number, userId: 'red' }, { client: gh.client, choice, backup: null })
		).rejects.toThrow(/C-001 was written by a mock model, and ivory-redteam is set to mock\/one, from the same family/);
		expect(listChats('red')).toEqual([]);
	});

	it('runs a red-team from another family, with the calibration example, and records the review', async () => {
		const gh = shelfWithNotes();
		gh.files.set('projects/bees/claims/C-001.md', GOOD_CLAIM);
		const task = gh.addIssue({ title: 'Red-team C-001', body: 'Attack C-001.', labels: ['project:bees', 'agent:ivory-redteam'] });
		const review = GOOD_CLAIM.replace('status: draft', 'status: challenged');
		const { choice, offered } = scripted([
			{ tool: 'shelf_write', args: { path: 'claims/C-001.md', content: review } },
			{ text: 'Challenged: proportional following is assumed.' }
		]);
		const seen: string[] = [];
		const wrapped = {
			...choice,
			adapter: {
				...choice.adapter,
				stream: (req: ChatRequest) => {
					seen.push(String(req.messages[0].content));
					return choice.adapter.stream(req as never);
				}
			}
		} as unknown as ModelChoice;
		const { job } = await startTaskRun(
			{ slug: 'bees', issueNumber: task.number, userId: 'red2' },
			{ client: gh.client, choice: wrapped, backup: null, paperSearch: async () => [] }
		);
		await finished(job);
		await until(() => gh.comments.length > 0);

		// The Shelf has no example of its own here, so the seeded one is used.
		expect(seen[0]).toContain("Hamilton's rule applies to siderophore production");
		for (const names of offered) {
			expect([...names].sort()).toEqual([
				'fetch_url',
				'paper_search',
				'read_paper',
				'set_status',
				'shelf_read',
				'shelf_write'
			]);
		}
		expect(parseClaim(gh.files.get('projects/bees/claims/C-001.md')!)).toMatchObject({
			status: 'challenged',
			reviewedBy: ['ivory-redteam + mock/one']
		});
		expect(gh.comments[0].body).toContain('Claims reviewed:');
		expect(gh.comments[0].body).toContain('status **challenged**');
	});
});
