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
import { fakeGithub, GOOD_NOTE, SAMPLE_BRIEF } from './github-fixture';
import { validateNote, WRITE_SOURCE_NOTE_SKILL } from './notes';
import { IvoryRunError, runScope, startReadRun } from './run';

/**
 * The reader end to end: an issue on a fake board, a scripted model, and the
 * real loop, tools and scope in between.
 */

beforeAll(() => {
	runMigrations();
	seedSkills();
});

type Step = { tool: string; args: Record<string, unknown> } | { text: string };

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
				const step = steps[i++] ?? { text: 'Done.' };
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

describe('startReadRun', () => {
	it('reads, writes a valid note, is refused outside its project, and comments on the issue', async () => {
		const { gh, task } = board();
		const { choice, offered } = scripted([
			{ tool: 'paper_search', args: { query: 'Seeley Wisdom of the Hive' } },
			{ tool: 'shelf_write', args: { path: 'projects/wasps/notes/N-001.md', content: GOOD_NOTE } },
			{ tool: 'shelf_write', args: { path: 'notes/N-002-seeley-1995.md', content: GOOD_NOTE } },
			{ text: 'Wrote notes/N-002-seeley-1995.md.' }
		]);
		const { chatId, job } = await startReadRun(
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
		await until(() => gh.comments.length > 0);

		// Exactly the brief's allowlist, on every round-trip.
		for (const names of offered) {
			expect([...names].sort()).toEqual(['fetch_url', 'paper_search', 'read_paper', 'shelf_read', 'shelf_write']);
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

	it('comments that nothing was written when the reader writes nothing', async () => {
		const { gh, task } = board();
		const { choice } = scripted([{ text: 'The source could not be found.' }]);
		const { job } = await startReadRun(
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
				startReadRun({ slug: 'bees', issueNumber: task.number, userId: 'no-skill' }, { client: gh.client, choice, backup: null })
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
		await expect(startReadRun({ slug: 'bees', issueNumber: other.number, userId: 'u' }, deps)).rejects.toThrow(
			/not labelled agent:ivory-read/
		);
		await expect(startReadRun({ slug: 'bees', issueNumber: elsewhere.number, userId: 'u' }, deps)).rejects.toThrow(
			IvoryRunError
		);
		expect(gh.commits).toEqual([]);
	});
});
