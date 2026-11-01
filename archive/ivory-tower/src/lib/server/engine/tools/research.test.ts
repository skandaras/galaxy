import { describe, expect, it } from 'vitest';
import { fakeGithub, GOOD_CLAIM, GOOD_NOTE } from '$lib/server/ivory/github-fixture';
import { parseClaim } from '$lib/server/ivory/claims';
import { routedFetch } from '$lib/server/ivory/scholarly-fixture';
import {
	checkAgainstReading,
	formatPapers,
	mapOpenAlex,
	newRunReading,
	paperSearchTool,
	PaperProviderError,
	rebuildAbstract,
	readPaperTool,
	recordingFetch,
	runPaperSearch,
	setStatusTool,
	searchPapersWith,
	shelfReadTool,
	shelfWriteTool,
	type PaperSearchConfig
} from './research';

const CFG: PaperSearchConfig = {
	provider: 'openalex',
	mailto: '',
	maxResults: 5,
	perTurn: 2,
	timeoutMs: 1000,
	s2Key: '',
	coreKey: ''
};

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
				primary_location: { landing_page_url: 'https://example.org/hive' },
				ids: { pmcid: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC42' },
				locations: [
					{ is_oa: true, pdf_url: 'https://arxiv.org/pdf/2101.00001v2', source: { type: 'repository', display_name: 'arXiv' } }
				]
			})
		).toEqual({
			title: 'The Wisdom of the Hive',
			authors: ['Thomas D. Seeley'],
			year: 1995,
			doi: 'https://doi.org/10.1/x',
			url: 'https://doi.org/10.1/x',
			abstract: 'hello',
			openAccess: true,
			oaUrl: 'https://example.org/hive.pdf',
			pmcid: 'PMC42',
			arxivId: '2101.00001'
		});
	});

	it('asks for the fields it maps, and tells a failure apart from no results', async () => {
		let asked = '';
		const ok = (async (url: URL) => {
			asked = String(url);
			return new Response(JSON.stringify({ results: [] }));
		}) as unknown as typeof fetch;
		expect(
			await searchPapersWith('openalex', { ...CFG, mailto: 'me@example.org' }, 'bees', { fromYear: 1990, fetchImpl: ok })
		).toEqual([]);
		expect(asked).toContain('search=bees');
		expect(asked).toContain('filter=from_publication_date%3A1990-01-01');
		expect(asked).toContain('mailto=me%40example.org');

		const down = (async () => new Response('busy', { status: 503 })) as unknown as typeof fetch;
		await expect(searchPapersWith('openalex', CFG, 'bees', { fetchImpl: down })).rejects.toThrow(PaperProviderError);
	});

	it('fences what it returns as untrusted, and says when nothing came back', () => {
		expect(formatPapers([], 'bees')).toMatch(/^No papers for "bees"/);
		const out = formatPapers(
			[
				{ title: 'T', authors: [], year: null, doi: null, url: 'u', abstract: '', openAccess: false, oaUrl: null, pmcid: null, arxivId: null },
				{ title: 'U', authors: [], year: null, doi: null, url: 'v', abstract: '', openAccess: true, oaUrl: null, pmcid: 'PMC1', arxivId: null }
			],
			'bees'
		);
		expect(out).toContain('--- BEGIN RESULTS ---');
		expect(out).toContain('Full text: no open copy listed; read_paper may still find a repository copy');
		expect(out).toContain('IDs: PMCID PMC1');
		expect(out).toContain('Full text: likely available; read it with read_paper');
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

describe('runPaperSearch', () => {
	it('falls back to Semantic Scholar when OpenAlex fails, and fills missing authors from Crossref', async () => {
		const { impl, asked } = routedFetch([
			['api.openalex.org', () => new Response('down', { status: 503 })],
			[
				'api.semanticscholar.org/graph/v1/paper/search',
				() =>
					new Response(
						JSON.stringify({
							data: [
								{
									title: 'Heritability in twins',
									year: 2001,
									authors: [],
									externalIds: { DOI: '10.1000/twins', PubMedCentral: '555' },
									openAccessPdf: null
								}
							]
						})
					)
			],
			['api.crossref.org/works/10.1000/twins', () => new Response(JSON.stringify({ message: { author: [{ given: 'Ada', family: 'Twin' }] } }))]
		]);
		const out = await runPaperSearch(CFG, 'twin heritability', { fetchImpl: impl });
		expect(out.provider).toBe('semanticscholar');
		expect(out.failedOver).toMatch(/openalex search failed/);
		expect(out.results).toEqual([
			expect.objectContaining({ authors: ['Ada Twin'], doi: 'https://doi.org/10.1000/twins', pmcid: 'PMC555', openAccess: true })
		]);
		expect(asked.map((a) => new URL(a.url).hostname)).toEqual([
			'api.openalex.org',
			'api.semanticscholar.org',
			'api.crossref.org'
		]);
	});

	it('does not fall back when the search worked and found nothing', async () => {
		const { impl, asked } = routedFetch([['api.openalex.org', () => new Response(JSON.stringify({ results: [] }))]]);
		expect((await runPaperSearch(CFG, 'nothing', { fetchImpl: impl })).results).toEqual([]);
		expect(asked).toHaveLength(1);
	});
});

describe('read_paper', () => {
	const long = `${'a'.repeat(24_000)}${'the second part holds the quoted passage '.repeat(20)}`;

	it('reads a long paper in parts from one lookup, and counts what was shown as read', async () => {
		let lookups = 0;
		const reading = newRunReading();
		const tool = readPaperTool(CFG, {
			read: async () => {
				lookups++;
				return { ok: true, text: long, source: 'Europe PMC', locator: 'PMC77', attempts: [] };
			},
			reading
		});
		const one = await tool.execute({ doi: 'https://doi.org/10.1000/kin' });
		expect(one).toMatch(/^Full text of PMC77, from Europe PMC\. Part 1 of 2\./);
		expect(one).toContain('(Part 2 continues; ask read_paper for it.)');
		const two = await tool.execute({ doi: '10.1000/KIN', part: 2 });
		expect(two).toContain('the second part holds the quoted passage');
		expect(lookups).toBe(1);

		const note = GOOD_NOTE.replace('access: abstract-only', 'access: full-text').replace(
			'- Quote: "dance duration scales with patch profitability"',
			'- Quote: "the second part holds the quoted passage"'
		);
		expect(checkAgainstReading(note, reading)).toEqual([]);
	});

	it('lists where it looked when there is no open text, and reads nothing', async () => {
		const reading = newRunReading();
		const tool = readPaperTool(CFG, {
			read: async () => ({
				ok: false,
				attempts: [
					{ source: 'Europe PMC', outcome: 'not in its open-access full-text set' },
					{ source: 'Publisher', outcome: 'refused (HTTP 403)' }
				]
			}),
			reading
		});
		expect(await tool.execute({ doi: '10.1000/closed' })).toBe(
			[
				'No open full text was found. Where it looked:',
				'- Europe PMC: not in its open-access full-text set',
				'- Publisher: refused (HTTP 403)',
				'',
				'Write the note from the abstract, with access: abstract-only.'
			].join('\n')
		);
		expect(reading).toEqual({ texts: [], readFullText: false });
	});

	it('needs something to look up', async () => {
		await expect(readPaperTool(CFG, { read: async () => ({ ok: false, attempts: [] }) }).execute({})).rejects.toThrow(
			/needs a DOI/
		);
	});
});

describe('set_status', () => {
	it('records a cleaned line and reaches nothing else', async () => {
		let recorded: string | null = null;
		const tool = setStatusTool((t) => (recorded = t));
		expect(await tool.execute({ summary: '  Two notes written.\n Next: #7. ' })).toMatch(/^Status recorded/);
		expect(recorded).toBe('Two notes written.\nNext: #7.');
		await expect(tool.execute({ summary: 'one\ntwo\nthree' })).rejects.toThrow('Status not set: Keep the status to one or two lines.');
	});
});

describe('shelf_write for claims', () => {
	const setup = (mode: 'claim' | 'review', model: string) => {
		const gh = fakeGithub();
		gh.files.set('projects/bees/brief.md', '---\ntitle: Bees\n---\n# Bees');
		gh.files.set('projects/bees/notes/N-002-seeley-1995.md', GOOD_NOTE);
		const writes: { path: string; status?: string }[] = [];
		const tool = shelfWriteTool(gh.client, { slug: 'bees', writable: ['claims/'] }, {
			mode,
			task: mode === 'claim' ? 'ivory-synthesise' : 'ivory-redteam',
			issueNumber: 5,
			issueUrl: 'https://github.com/owner/shelf/issues/5',
			modelKey: () => model,
			reading: newRunReading(),
			onWrite: (w) => writes.push(w)
		});
		return { gh, tool, writes };
	};

	it('lets the synthesiser write a draft, stamped as its own', async () => {
		const { gh, tool, writes } = setup('claim', 'z-ai/glm-5.3');
		const sneaky = GOOD_CLAIM.replace('authored_by: "ivory-synthesise + z-ai/glm-5.3"', 'authored_by: "Sam"');
		await tool.execute({ path: 'claims/C-001.md', content: sneaky });
		const stored = parseClaim(gh.files.get('projects/bees/claims/C-001.md')!);
		expect(stored.authoredBy).toBe('ivory-synthesise + z-ai/glm-5.3');
		expect(gh.commits[0].message).toBe('ivory-synthesise (z-ai/glm-5.3): add claims/C-001.md for #5');
		expect(writes).toEqual([expect.objectContaining({ path: 'projects/bees/claims/C-001.md', status: 'draft' })]);
	});

	it('will not let the synthesiser mark its own claim anything but draft, or write outside claims/', async () => {
		const { gh, tool } = setup('claim', 'z-ai/glm-5.3');
		await expect(
			tool.execute({ path: 'claims/C-001.md', content: GOOD_CLAIM.replace('status: draft', 'status: survived') })
		).rejects.toThrow(/status must be draft/);
		await expect(tool.execute({ path: 'notes/N-003.md', content: GOOD_CLAIM })).rejects.toThrow(/may write only/);
		expect(gh.commits).toEqual([]);
	});

	it('lets a red-team from another family review, keeping authorship and adding itself', async () => {
		const { gh, tool, writes } = setup('review', '~openai/gpt-luna-latest');
		gh.files.set('projects/bees/claims/C-001.md', GOOD_CLAIM);
		const review = GOOD_CLAIM.replace('status: draft', 'status: challenged')
			.replace('authored_by: "ivory-synthesise + z-ai/glm-5.3"', 'authored_by: "Sam"')
			.replace('## Red-team log\n', '## Red-team log\n### R1\n- Objection: proportional following is assumed.\n- Outcome: open\n');
		await tool.execute({ path: 'claims/C-001.md', content: review });
		const stored = parseClaim(gh.files.get('projects/bees/claims/C-001.md')!);
		expect(stored).toMatchObject({
			status: 'challenged',
			authoredBy: 'ivory-synthesise + z-ai/glm-5.3',
			reviewedBy: ['ivory-redteam + ~openai/gpt-luna-latest']
		});
		expect(gh.commits[0].message).toBe('ivory-redteam (~openai/gpt-luna-latest): review claims/C-001.md for #5');
		expect(writes[0].status).toBe('challenged');
	});

	it('refuses a red-team from the author\'s own family, a new claim, and a draft', async () => {
		const same = setup('review', 'z-ai/glm-4.6');
		same.gh.files.set('projects/bees/claims/C-001.md', GOOD_CLAIM);
		await expect(
			same.tool.execute({ path: 'claims/C-001.md', content: GOOD_CLAIM.replace('status: draft', 'status: survived') })
		).rejects.toThrow(/same model family \(z-ai\)/);

		const other = setup('review', 'anthropic/claude-sonnet-5');
		await expect(other.tool.execute({ path: 'claims/C-002.md', content: GOOD_CLAIM })).rejects.toThrow(
			/Only an existing claim can be reviewed/
		);
		other.gh.files.set('projects/bees/claims/C-001.md', GOOD_CLAIM);
		await expect(other.tool.execute({ path: 'claims/C-001.md', content: GOOD_CLAIM })).rejects.toThrow(/never draft/);
		expect([...same.gh.commits, ...other.gh.commits]).toEqual([]);
	});
});
