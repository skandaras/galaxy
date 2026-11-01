import { describe, expect, it } from 'vitest';
import { fakeGithub, SAMPLE_BRIEF } from './github-fixture';
import { groupByDiscipline, listProjects, projectFromBrief, questionOf, UNFILED } from './shelf';
import { shelfIndex, shelfProjectView } from './view';
import { withStatus } from './status';

describe('projectFromBrief', () => {
	it('takes the slug from the folder and the question from its section', () => {
		const p = projectFromBrief('bees-and-queues', SAMPLE_BRIEF.replace('slug: bees-and-queues', 'slug: typo'));
		expect(p.slug).toBe('bees-and-queues');
		expect(p.title).toBe('Waggle dances as load balancing');
		expect(p.disciplines).toEqual(['entomology', 'operations-research']);
		expect(p.question).toBe(
			'Do honeybee recruitment dances allocate foragers the way a load balancer allocates requests?'
		);
	});

	it('finds no question where there is no section', () => {
		expect(questionOf('# T\n\n## Scope\nIn:')).toBe('');
	});
});

describe('groupByDiscipline', () => {
	const p = (slug: string, disciplines: string[]) => ({ ...projectFromBrief(slug, ''), disciplines });

	it('lists a project under every discipline it names, and the unfiled last', () => {
		const groups = groupByDiscipline([p('a', ['physics', 'biology']), p('b', []), p('c', ['biology'])]);
		expect(groups.map((g) => [g.discipline, g.projects.map((x) => x.slug)])).toEqual([
			['biology', ['a', 'c']],
			['physics', ['a']],
			[UNFILED, ['b']]
		]);
	});
});

describe('the Shelf index', () => {
	it('shows a two-discipline project under both, with its open task count', async () => {
		const gh = fakeGithub();
		gh.files.set('projects/bees-and-queues/brief.md', SAMPLE_BRIEF);
		gh.files.set('projects/Not_A_Slug/brief.md', SAMPLE_BRIEF);
		gh.files.set('templates/brief.md', '---\n---\n');
		gh.addIssue({ title: 'Project', labels: ['project:bees-and-queues', 'discipline:entomology'] });
		gh.addIssue({ title: 'Read Seeley', labels: ['project:bees-and-queues', 'agent:ivory-read'] });
		gh.addIssue({ title: 'A pull request', labels: ['project:bees-and-queues'], pull: true });

		const index = await shelfIndex(gh.client);
		expect(index.projectCount).toBe(1);
		expect(index.groups.map((g) => g.discipline)).toEqual(['entomology', 'operations-research']);
		for (const g of index.groups) {
			expect(g.projects.map((x) => [x.slug, x.openTasks])).toEqual([['bees-and-queues', 1]]);
		}
		expect(index.groups[0].projects[0].status).toBeNull();

		// The status line comes from the project issue, read from the same listing.
		gh.issues[0].body = withStatus('', { text: 'Two notes in.', by: 'Galaxy', at: '2026-09-25 10:00' });
		gh.clock.now += 61_000;
		expect((await shelfIndex(gh.client)).groups[0].projects[0].status?.text).toBe('Two notes in.');
	});

	it('reads an empty repository as no projects rather than an error', async () => {
		const gh = fakeGithub('owner/shelf', { empty: true });
		expect(await listProjects(gh.client)).toEqual([]);
	});

	it('shows a closed issue as gone once the cache has expired, and not before', async () => {
		const gh = fakeGithub();
		gh.files.set('projects/bees-and-queues/brief.md', SAMPLE_BRIEF);
		const task = gh.addIssue({ title: 'Read Seeley', labels: ['project:bees-and-queues'] });
		const count = async () => (await shelfIndex(gh.client)).groups[0].projects[0].openTasks;

		expect(await count()).toBe(1);
		task.state = 'closed';
		gh.clock.now += 30_000;
		expect(await count()).toBe(1);
		gh.clock.now += 31_000;
		expect(await count()).toBe(0);
	});
});

describe('the project view', () => {
	it('lists notes, claims with their status, and the open tasks without the project issue', async () => {
		const gh = fakeGithub();
		gh.files.set(
			'projects/bees-and-queues/brief.md',
			SAMPLE_BRIEF.replace('board: ""', 'board: "https://github.com/owner/shelf/issues/1"')
		);
		gh.files.set('projects/bees-and-queues/notes/N-001-seeley.md', '---\nid: N-001\n---\n');
		gh.files.set('projects/bees-and-queues/claims/C-001.md', '---\nid: C-001\nstatus: challenged\n---\n# C-001: dances are queues\n');
		gh.files.set('projects/other/notes/N-009.md', '');
		gh.addIssue({ title: 'Project', labels: ['project:bees-and-queues'] });
		gh.addIssue({ title: 'Read Seeley', labels: ['project:bees-and-queues', 'agent:ivory-read'] });

		const view = await shelfProjectView(gh.client, 'bees-and-queues');
		expect(view?.notes.map((n) => n.name)).toEqual(['N-001-seeley.md']);
		expect(view?.claims.map((c) => [c.id, c.status, c.title])).toEqual([
			['C-001', 'challenged', 'C-001: dances are queues']
		]);
		expect(view?.projectIssue).toBe(1);
		expect(view?.issues.map((i) => [i.number, i.agent])).toEqual([[2, 'ivory-read']]);
		expect(view?.briefBody.startsWith('<!--')).toBe(true);
	});

	it('answers null for a slug that is not a folder name', async () => {
		const gh = fakeGithub();
		expect(await shelfProjectView(gh.client, '../etc')).toBeNull();
		expect(gh.requests).toEqual([]);
	});
});
