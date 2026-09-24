import { describe, expect, it } from 'vitest';
import { PageFetchError } from '$lib/server/engine/research';
import { readFullText, unusable } from './fulltext';
import { routedFetch } from './scholarly-fixture';
import type { ScholarlyConfig } from './scholarly';

const PAPER = 'Relatedness favours siderophore production in iron-limited media. '.repeat(80);
const json = (body: unknown) => () => new Response(JSON.stringify(body));

function setup(routes: [string, () => Response][], pages: Record<string, () => string> = {}, keys = {}) {
	const { impl, asked } = routedFetch(routes);
	const cfg: ScholarlyConfig = { mailto: '', coreKey: '', s2Key: '', timeoutMs: 1000, fetchImpl: impl, ...keys };
	const read: string[] = [];
	const pageText = async (url: string) => {
		read.push(url);
		const page = Object.entries(pages).find(([part]) => url.includes(part));
		if (!page) throw new PageFetchError('blocked', 'HTTP 403 Forbidden', 403);
		return page[1]();
	};
	return { cfg, asked, read, run: (ref: Parameters<typeof readFullText>[0]) => readFullText(ref, cfg, { pageText }) };
}

describe('unusable', () => {
	it('knows a bot check and a stub from a paper', () => {
		expect(unusable('Just a moment... Checking your browser before accessing.')).toBe('a bot check, not the paper');
		expect(unusable('An abstract only.')).toMatch(/^only 17 characters/);
		expect(unusable(PAPER)).toBeNull();
		// A long paper that mentions a captcha is still a paper.
		expect(unusable(`We used a captcha task. ${'x'.repeat(30_000)}`)).toBeNull();
	});
});

describe('readFullText', () => {
	it('takes Europe PMC first for a paper in PubMed Central, and asks nothing further', async () => {
		const { run, asked } = setup([
			['api.openalex.org', json({ ids: { pmcid: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC77' }, locations: [] })],
			['PMC77/fullTextXML', () => new Response(`<article><body><sec><title>Results</title><p>${PAPER}</p></sec></body></article>`)]
		]);
		const got = await run({ doi: '10.1000/kin' });
		expect(got).toMatchObject({ ok: true, source: 'Europe PMC', locator: 'PMC77' });
		expect(got.ok && got.text.startsWith('## Results')).toBe(true);
		expect(asked.map((a) => new URL(a.url).hostname)).toEqual(['api.openalex.org', 'www.ebi.ac.uk']);
	});

	it('reads arXiv when the paper is a preprint there', async () => {
		const { run, read } = setup(
			[['api.openalex.org', json({ doi: 'https://doi.org/10.48550/arxiv.2101.00001', locations: [] })]],
			{ 'export.arxiv.org/pdf/2101.00001': () => PAPER }
		);
		expect(await run({ doi: '10.48550/arXiv.2101.00001' })).toMatchObject({
			ok: true,
			source: 'arXiv',
			locator: 'arXiv:2101.00001'
		});
		expect(read).toEqual(['https://export.arxiv.org/pdf/2101.00001']);
	});

	it('uses CORE when it has a key and the paper is in a repository', async () => {
		const { run } = setup(
			[
				['api.openalex.org', json({ locations: [] })],
				['europepmc/webservices/rest/search', json({ resultList: { result: [] } })],
				['api.core.ac.uk', json({ results: [{ fullText: PAPER }] })]
			],
			{},
			{ coreKey: 'k' }
		);
		expect(await run({ doi: '10.1000/repo' })).toMatchObject({ ok: true, source: 'CORE' });
	});

	it('passes over a publisher that refuses and a bot check, to a copy that reads', async () => {
		const { run, read } = setup(
			[
				[
					'api.openalex.org',
					json({
						locations: [
							{ is_oa: true, landing_page_url: 'https://publisher.example/a', source: { type: 'journal', display_name: 'Publisher' } },
							{ is_oa: true, pdf_url: 'https://challenge.example/a.pdf', source: { type: 'repository', display_name: 'Guarded' } },
							{ is_oa: true, pdf_url: 'https://repo.example/a.pdf', source: { type: 'repository', display_name: 'Open repo' } }
						]
					})
				]
			],
			{
				'challenge.example': () => 'Just a moment... Enable JavaScript and cookies to continue',
				'repo.example': () => PAPER
			}
		);
		const got = await run({ doi: '10.1000/blocked' });
		expect(got).toMatchObject({ ok: true, source: 'Open repo (repository)', locator: 'https://repo.example/a.pdf' });
		expect(read).toEqual(['https://challenge.example/a.pdf', 'https://repo.example/a.pdf']);
		expect(got.attempts).toContainEqual({ source: 'Guarded (repository)', outcome: 'a bot check, not the paper' });
	});

	it('says where it looked and why each failed when nothing is open', async () => {
		const { run } = setup(
			[
				['api.openalex.org', json({ locations: [{ is_oa: true, landing_page_url: 'https://publisher.example/a', source: { type: 'journal', display_name: 'Publisher' } }] })],
				['europepmc/webservices/rest/search', json({ resultList: { result: [] } })]
			]
		);
		const got = await run({ doi: '10.1000/paywalled' });
		expect(got).toEqual({
			ok: false,
			attempts: [
				{ source: 'Europe PMC', outcome: 'not in its open-access full-text set' },
				{ source: 'CORE', outcome: 'skipped, no API key (Admin → Settings → Shelf)' },
				{ source: 'Semantic Scholar', outcome: 'skipped, no API key (Admin → Settings → Shelf)' },
				{ source: 'Publisher', outcome: 'refused (HTTP 403)' }
			]
		});
	});

	it('refuses to guess with nothing to look up', async () => {
		const { run, asked } = setup([]);
		expect(await run({})).toEqual({ ok: false, attempts: [{ source: 'lookup', outcome: 'no DOI, arXiv id or PMCID to look up' }] });
		expect(asked).toEqual([]);
	});
});
