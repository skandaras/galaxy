import { describe, expect, it } from 'vitest';
import { fakeGithub, GOOD_NOTE } from '$lib/server/ivory/github-fixture';
import {
	checkAgainstReading,
	formatPapers,
	mapOpenAlex,
	newRunReading,
	paperSearchTool,
	PaperProviderError,
	rebuildAbstract,
	recordingFetch,
	searchPapersWith,
	shelfReadTool,
	shelfWriteTool,
	type PaperSearchConfig
} from './research';

const CFG: PaperSearchConfig = { provider: 'openalex', mailto: '', maxResults: 5, perTurn: 2, timeoutMs: 1000 };

describe('OpenAlex', () => {
	it('puts an inverted abstract back in order', () => {
		expect(rebuildAbstract({ scales: [2], dance: [0], duration: [1], 'profitability.': [3] })).toBe(
			'dance duration scales profitability.'
		);
		expect(rebuildAbstract(null)).toBe('');
	});

	it('maps a work, preferring the DOI as its address', () => {
		expect(
			mapOpenAlex({
				id: 'https://openalex.org/W1',
				doi: 'https://doi.org/10.1/x',
				display_name: 'The Wisdom of the Hive',
				publication_year: 1995,
				authorships: [{ author: { display_name: 'Thomas D. Seeley' } }],
				abstract_inverted_index: { hello: [0] },
				open_access: { is_oa: true, oa_url: 'https://example.org/hive.pdf' },
				primary_location: { landing_page_url: 'https://example.org/hive' }
			})
		).toEqual({
			title: 'The Wisdom of the Hive',
			authors: ['Thomas D. Seeley'],
			year: 1995,
			doi: 'https://doi.org/10.1/x',
			url: 'https://doi.org/10.1/x',
			abstract: 'hello',
			openAccess: true,
			oaUrl: 'https://example.org/hive.pdf'
		});
	});

	it('asks for the fields it maps, and tells a failure apart from no results', async () => {
		let asked = '';
		const ok = (async (url: URL) => {
			asked = String(url);
			return new Response(JSON.stringify({ results: [] }));
		}) as unknown as typeof fetch;
		expect(await searchPapersWith({ ...CFG, mailto: 'me@example.org' }, 'bees', { fromYear: 1990, fetchImpl: ok })).toEqual([]);
		expect(asked).toContain('search=bees');
		expect(asked).toContain('filter=from_publication_date%3A1990-01-01');
		expect(asked).toContain('mailto=me%40example.org');

		const down = (async () => new Response('busy', { status: 503 })) as unknown as typeof fetch;
		await expect(searchPapersWith(CFG, 'bees', { fetchImpl: down })).rejects.toThrow(PaperProviderError);
	});

	it('fences what it returns as untrusted, and says when nothing came back', () => {
		expect(formatPapers([], 'bees')).toMatch(/^No papers for "bees"/);
		const out = formatPapers(
			[{ title: 'T', authors: [], year: null, doi: null, url: 'u', abstract: '', openAccess: false, oaUrl: null }],
			'bees'
		);
		expect(out).toContain('--- BEGIN RESULTS ---');
		expect(out).toContain('Open-access full text: no');
	});
});

describe('paper_search', () => {
	it('serves a repeat from memory and stops at the turn allowance', async () => {
		let calls = 0;
		const read: string[] = [];
		const tool = paperSearchTool(CFG, {
			search: async () => {
				calls++;
				return [];
			},
			onRead: (t) => read.push(t)
		});
		await tool.execute({ query: 'bees' });
		await tool.execute({ query: 'Bees' });
		await tool.execute({ query: 'wasps' });
		expect(await tool.execute({ query: 'ants' })).toMatch(/^Not run/);
		expect(calls).toBe(2);
		expect(read).toHaveLength(2);
	});
});

describe('the run reading', () => {
	const abstract = 'Seeley shows that dance duration scales with patch profitability across colonies.';

	it('accepts a quote from something read, and refuses one from nowhere', () => {
		const reading = newRunReading();
		reading.texts.push(abstract);
		expect(checkAgainstReading(GOOD_NOTE, reading)).toEqual([]);
		expect(checkAgainstReading(GOOD_NOTE, newRunReading())).toEqual([
			'The quote for N-002.1 does not appear in anything read in this run. Copy it word for word from the source, or remove the claim.'
		]);
	});

	it('refuses full-text unless a page was read, and only counts a page actually returned', async () => {
		const reading = newRunReading();
		reading.texts.push(abstract);
		const fullText = GOOD_NOTE.replace('access: abstract-only', 'access: full-text');
		expect(checkAgainstReading(fullText, reading)[0]).toMatch(/^access is full-text/);

		const refused = recordingFetch({ def: { name: 'fetch_url', description: '', parameters: {} }, execute: async () => 'Fetch budget is spent.' }, reading);
		await refused.execute({ url: 'x' });
		expect(reading.readFullText).toBe(false);
		const read = recordingFetch(
			{ def: { name: 'fetch_url', description: '', parameters: {} }, execute: async () => '--- BEGIN CONTENT ---\nfull text\n--- END CONTENT ---' },
			reading
		);
		await read.execute({ url: 'x' });
		expect(checkAgainstReading(fullText, reading)).toEqual([]);
	});
});

describe('shelf_read and shelf_write', () => {
	const setup = () => {
		const gh = fakeGithub();
		gh.files.set('projects/bees/brief.md', '---\ntitle: Bees\n---\n# Bees');
		gh.files.set('projects/bees/notes/N-001-old.md', 'old');
		gh.files.set('projects/wasps/brief.md', 'secret');
		const reading = newRunReading();
		reading.texts.push('Seeley shows that dance duration scales with patch profitability.');
		const writes: string[] = [];
		const write = shelfWriteTool(gh.client, { slug: 'bees', writable: ['notes/'] }, {
			task: 'ivory-read',
			issueNumber: 2,
			issueUrl: 'https://github.com/owner/shelf/issues/2',
			modelKey: () => 'mock/one',
			reading,
			onWrite: (w) => writes.push(w.path)
		});
		const read = shelfReadTool(gh.client, { slug: 'bees', writable: [] });
		return { gh, write, read, writes };
	};

	it('reads and lists inside the project, and nowhere else', async () => {
		const { read, gh } = setup();
		expect(await read.execute({ path: 'notes/' })).toBe('notes/N-001-old.md');
		expect(await read.execute({ path: 'brief.md' })).toContain('--- BEGIN FILE ---');
		await expect(read.execute({ path: 'projects/wasps/brief.md' })).rejects.toThrow(/another project's folder/);
		expect(gh.requests.some((r) => r.path.includes('wasps'))).toBe(false);
	});

	it('writes a valid note as a commit naming the task and the model, with the stamped fields', async () => {
		const { write, gh, writes } = setup();
		const note = GOOD_NOTE.replace(/read_by: .*\n/, '').replace(/task: .*\n/, 'task: "made up"\n');
		const out = await write.execute({ path: 'notes/N-002-seeley-1995.md', content: note });
		expect(out).toMatch(/^Written to projects\/bees\/notes\/N-002-seeley-1995.md \(new file\)/);
		expect(gh.commits).toEqual([
			{ path: 'projects/bees/notes/N-002-seeley-1995.md', message: 'ivory-read (mock/one): add notes/N-002-seeley-1995.md for #2' }
		]);
		const stored = gh.files.get('projects/bees/notes/N-002-seeley-1995.md')!;
		expect(stored).toContain('read_by: "ivory-read + mock/one"');
		expect(stored).toContain('task: "https://github.com/owner/shelf/issues/2"');
		expect(writes).toEqual(['projects/bees/notes/N-002-seeley-1995.md']);
	});

	it('overwrites an existing note, and says so in the commit', async () => {
		const { write, gh } = setup();
		gh.files.set('projects/bees/notes/N-002-seeley-1995.md', 'draft');
		await write.execute({ path: 'notes/N-002-seeley-1995.md', content: GOOD_NOTE });
		expect(gh.commits[0].message).toBe('ivory-read (mock/one): update notes/N-002-seeley-1995.md for #2');
	});

	it("refuses another project's folder without touching GitHub", async () => {
		const { write, gh } = setup();
		await expect(write.execute({ path: 'projects/wasps/notes/N-001.md', content: GOOD_NOTE })).rejects.toThrow(
			/another project's folder/
		);
		expect(gh.requests).toEqual([]);
	});

	it('hands back every problem with a note instead of writing it', async () => {
		const { write, gh } = setup();
		const bad = GOOD_NOTE.replace('- Quote: "dance duration scales with patch profitability"', '- Quote: "bees are nice"');
		await expect(write.execute({ path: 'notes/N-002.md', content: bad })).rejects.toThrow(
			/Not written[\s\S]*does not appear in anything read/
		);
		expect(gh.commits).toEqual([]);
	});
});
