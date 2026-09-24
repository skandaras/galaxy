import { describe, expect, it } from 'vitest';
import { fakeGithub } from './github-fixture';
import { createProject, ProjectError, renderBrief, slugify, validateProjectInput } from './create';
import { parseFrontmatter } from './frontmatter';
import { projectFromBrief } from './shelf';
import { readStatus } from './status';

const FORM = {
	title: 'Hamilton’s rule in biofilms',
	disciplines: 'Evolutionary Biology, microbiology',
	validationTier: 'reading',
	question: 'Does Hamilton’s rule predict\nsiderophore production in biofilms?',
	whyNew: 'A hunch.',
	scopeIn: 'Pseudomonas',
	scopeOut: 'Lab work',
	doneWhen: 'A mapping claim reaches survived.',
	killCriteria: 'Microbiology already has it.',
	startingPoints: '## Griffin 2004\nWest et al.',
	plannerNotes: ''
};

describe('validateProjectInput', () => {
	it('fills the slug from the title and tidies the disciplines', () => {
		const { input, problems } = validateProjectInput(FORM);
		expect(problems).toEqual({});
		expect(input.slug).toBe('hamilton-s-rule-in-biofilms');
		expect(input.disciplines).toEqual(['evolutionary-biology', 'microbiology']);
	});

	it('names every problem, by field', () => {
		expect(validateProjectInput({ slug: 'Not A Slug', validationTier: 'vibes' }).problems).toEqual({
			title: 'A title of 1 to 120 characters is needed.',
			slug: 'Lower-case letters, digits and dashes, starting with a letter or digit, at most 64.',
			disciplines: 'At least one discipline is needed.',
			validationTier: 'reading, computation or lab.',
			question: 'The question is the one thing the planner cannot work without.',
			doneWhen: 'Say what ends the project.',
			killCriteria: 'Say what would stop it early; the planner checks these first.'
		});
	});

	it('will not use the folder name the form itself lives at', () => {
		expect(validateProjectInput({ ...FORM, slug: 'new' }).problems.slug).toMatch(/taken by the new-project page/);
	});

	it('keeps long titles to a folder name that ends on a word', () => {
		const slug = slugify('A very long title about the structural transfer of mechanisms between distant fields of study');
		expect(slug.length).toBeLessThanOrEqual(64);
		expect(slug.endsWith('-')).toBe(false);
	});
});

describe('renderBrief', () => {
	it('writes the template, which reads back as the same project', () => {
		const { input } = validateProjectInput(FORM);
		const brief = renderBrief(input, new Date('2026-09-25T10:00:00Z'));
		const { meta } = parseFrontmatter(brief);
		expect(meta).toMatchObject({
			slug: 'hamilton-s-rule-in-biofilms',
			title: 'Hamilton’s rule in biofilms',
			disciplines: ['evolutionary-biology', 'microbiology'],
			board: '',
			validation_tier: 'reading',
			created: '2026-09-25'
		});
		const project = projectFromBrief(input.slug, brief);
		expect(project.question).toBe('Does Hamilton’s rule predict siderophore production in biofilms?');
		// A heading typed into a field cannot end its section early.
		expect(brief).toContain('## Starting points\n\\## Griffin 2004\nWest et al.');
		for (const h of ['Why this might be new', 'Scope', 'Done when', 'Kill criteria', 'Notes for the planner']) {
			expect(brief).toContain(`## ${h}\n`);
		}
	});
});

describe('createProject', () => {
	it('writes the brief, makes the labelled project issue, links it, and sets the first status', async () => {
		const gh = fakeGithub('owner/shelf', { empty: true });
		const out = await createProject(gh.client, FORM, new Date('2026-09-25T10:00:00Z'));
		expect(out).toEqual({ slug: 'hamilton-s-rule-in-biofilms' });

		const brief = gh.files.get('projects/hamilton-s-rule-in-biofilms/brief.md')!;
		expect(gh.commits[0]).toEqual({
			path: 'projects/hamilton-s-rule-in-biofilms/brief.md',
			message: 'Create project hamilton-s-rule-in-biofilms from Galaxy'
		});
		expect(gh.issues).toHaveLength(1);
		const issue = gh.issues[0];
		expect(issue.labels).toEqual([
			'project:hamilton-s-rule-in-biofilms',
			'discipline:evolutionary-biology',
			'discipline:microbiology'
		]);
		expect(parseFrontmatter(brief).meta.board).toBe(`https://github.com/owner/shelf/issues/${issue.number}`);
		expect(readStatus(issue.body)).toEqual({
			text: 'Project created. Next: plan its first tasks.',
			by: 'Galaxy',
			at: '2026-09-25 10:00'
		});
	});

	it('refuses a folder name already on the Shelf, and writes nothing', async () => {
		const gh = fakeGithub();
		gh.files.set('projects/hamilton-s-rule-in-biofilms/brief.md', 'taken');
		const err = await createProject(gh.client, FORM).catch((e) => e);
		expect(err).toBeInstanceOf(ProjectError);
		expect(err.status).toBe(409);
		expect(err.problems).toEqual({ slug: 'Already taken; choose another.' });
		expect(gh.commits).toEqual([]);
	});

	it('refuses an incomplete form before touching GitHub', async () => {
		const gh = fakeGithub();
		await expect(createProject(gh.client, { title: 'x' })).rejects.toThrow('Some fields need attention.');
		expect(gh.requests).toEqual([]);
	});

	it('keeps the project when GitHub will not label its issue, and says so', async () => {
		const gh = fakeGithub('owner/shelf', { labels: 'refuse' });
		const out = await createProject(gh.client, FORM);
		expect(gh.files.has('projects/hamilton-s-rule-in-biofilms/brief.md')).toBe(true);
		expect(out.warning).toMatch(/^The project was created, but its GitHub issue was not: GitHub created #1 but would not give it/);
		// Linked anyway, so a later status write uses #1 rather than filing a second issue.
		expect(parseFrontmatter(gh.files.get('projects/hamilton-s-rule-in-biofilms/brief.md')!).meta.board).toBe(
			'https://github.com/owner/shelf/issues/1'
		);
		gh.issues[0].labels = ['project:hamilton-s-rule-in-biofilms'];
		const { writeProjectStatus } = await import('./status');
		await writeProjectStatus(gh.client, 'hamilton-s-rule-in-biofilms', { text: 'Labelled by hand.', by: 'Galaxy' });
		expect(gh.issues).toHaveLength(1);
		expect(readStatus(gh.issues[0].body)?.text).toBe('Labelled by hand.');
	});
});
