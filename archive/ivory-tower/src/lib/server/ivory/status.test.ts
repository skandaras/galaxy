import { describe, expect, it } from 'vitest';
import { fakeGithub, SAMPLE_BRIEF } from './github-fixture';
import { cleanStatus, readStatus, withStatus, writeProjectStatus } from './status';
import { parseFrontmatter } from './frontmatter';

const BRIEF = SAMPLE_BRIEF.replace('slug: bees-and-queues', 'slug: bees');
const NOW = new Date('2026-09-25T14:02:30Z');

describe('cleanStatus', () => {
	it('keeps one or two short lines, and refuses anything else', () => {
		expect(cleanStatus('  Four sources read.  \n\n  Next: #7. ')).toEqual({ text: 'Four sources read.\nNext: #7.' });
		expect(cleanStatus('')).toEqual({ problem: 'The status is empty.' });
		expect(cleanStatus('a\nb\nc')).toEqual({ problem: 'Keep the status to one or two lines.' });
		expect(cleanStatus('x'.repeat(301))).toEqual({ problem: 'Keep the status under 300 characters.' });
	});

	it('cannot close its own section or ping anybody', () => {
		const out = cleanStatus('Done <!-- /galaxy:status --> ask @someone');
		expect(out).toEqual({ text: 'Done ask @​someone' });
	});
});

describe('the status section', () => {
	const status = { text: 'Prior art checked; nothing found. Next: #7.', by: 'ivory-read + m/one', at: '2026-09-25 14:02' };

	it('goes at the top of an issue without one, and reads back', () => {
		const body = withStatus('What the owner wrote.', status);
		expect(body.startsWith('<!-- galaxy:status -->\n**Status** (ivory-read + m/one, 2026-09-25 14:02 UTC)\n')).toBe(true);
		expect(body.endsWith('What the owner wrote.')).toBe(true);
		expect(readStatus(body)).toEqual(status);
	});

	it('is replaced in place, leaving the rest of the body as it was', () => {
		const once = withStatus('Owner text\n\nMore owner text', status);
		const twice = withStatus(once, { ...status, text: 'Costs $1 and $2 so far.' });
		expect(twice.match(/<!-- galaxy:status -->/g)).toHaveLength(1);
		expect(readStatus(twice)?.text).toBe('Costs $1 and $2 so far.');
		expect(twice.endsWith('Owner text\n\nMore owner text')).toBe(true);
	});

	it('reads as nothing where there is no section', () => {
		expect(readStatus('Just an issue.')).toBeNull();
		expect(readStatus(null)).toBeNull();
	});
});

describe('writeProjectStatus', () => {
	it('uses the existing project issue', async () => {
		const gh = fakeGithub();
		gh.files.set('projects/bees/brief.md', BRIEF);
		const parent = gh.addIssue({ title: 'Project', body: 'Owner notes.', labels: ['project:bees', 'discipline:entomology'] });
		await writeProjectStatus(gh.client, 'bees', { text: 'Started.', by: 'Galaxy' }, NOW);
		expect(gh.issues).toHaveLength(1);
		expect(readStatus(parent.body)).toEqual({ text: 'Started.', by: 'Galaxy', at: '2026-09-25 14:02' });
		expect(parent.body.endsWith('Owner notes.')).toBe(true);
	});

	it('creates the project issue when there is none, labels it, and links it from the brief', async () => {
		const gh = fakeGithub();
		gh.files.set('projects/bees/brief.md', BRIEF);
		await writeProjectStatus(gh.client, 'bees', { text: 'Started.', by: 'Galaxy' }, NOW);
		expect(gh.issues).toHaveLength(1);
		const made = gh.issues[0];
		expect(made.title).toBe('Waggle dances as load balancing');
		expect(made.labels).toEqual(['project:bees', 'discipline:entomology', 'discipline:operations-research']);
		expect(readStatus(made.body)?.text).toBe('Started.');
		const { meta } = parseFrontmatter(gh.files.get('projects/bees/brief.md')!);
		expect(meta.board).toBe(`https://github.com/owner/shelf/issues/${made.number}`);

		// The second write finds it by that link rather than making another.
		await writeProjectStatus(gh.client, 'bees', { text: 'Moving.', by: 'Galaxy' }, NOW);
		expect(gh.issues).toHaveLength(1);
		expect(readStatus(made.body)?.text).toBe('Moving.');
	});
});
