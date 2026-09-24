import { describe, expect, it } from 'vitest';
import { fakeGithub, SAMPLE_BRIEF } from './github-fixture';
import { setupShelf } from './setup';

describe('setupShelf', () => {
	it('seeds an empty repository: README, templates, the sample project and every label', async () => {
		const gh = fakeGithub('owner/shelf', { empty: true });
		const result = await setupShelf(gh.client);
		expect(result.written).toEqual([
			'README.md',
			'projects/sample-pheromone-routing/brief.md',
			'templates/brief.md',
			'templates/claim-mapping.md',
			'templates/note.md'
		]);
		expect(result.labelsCreated).toEqual(
			expect.arrayContaining([
				'agent:ivory-read',
				'agent:ivory-plan',
				'project:sample-pheromone-routing',
				'discipline:entomology',
				'discipline:network-engineering'
			])
		);
	});

	it('changes nothing on a second run', async () => {
		const gh = fakeGithub('owner/shelf', { empty: true });
		await setupShelf(gh.client);
		const commits = gh.commits.length;
		expect(await setupShelf(gh.client)).toEqual({ written: [], labelsCreated: [] });
		expect(gh.commits.length).toBe(commits);
	});

	it('never overwrites an edited template, and leaves out the sample once real projects exist', async () => {
		const gh = fakeGithub();
		gh.files.set('templates/note.md', 'mine');
		gh.files.set('projects/bees-and-queues/brief.md', SAMPLE_BRIEF);
		const { written } = await setupShelf(gh.client);
		expect(written).not.toContain('templates/note.md');
		expect(written.some((p) => p.startsWith('projects/'))).toBe(false);
		expect(gh.files.get('templates/note.md')).toBe('mine');
	});
});
