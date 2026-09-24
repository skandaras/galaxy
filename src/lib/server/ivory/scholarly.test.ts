import { describe, expect, it } from 'vitest';
import {
	arxivIdFrom,
	coreFullText,
	crossrefAuthors,
	doiPath,
	jatsToText,
	normaliseDoi,
	openAccessLocations,
	pmcidFrom,
	semanticScholarPaper,
	type ScholarlyConfig
} from './scholarly';
import { routedFetch } from './scholarly-fixture';

const CFG: ScholarlyConfig = { mailto: '', coreKey: '', s2Key: '', timeoutMs: 1000 };

describe('identifiers', () => {
	it('reads a DOI however it is written, and only a DOI', () => {
		expect(normaliseDoi('https://doi.org/10.1038/Nature02744')).toBe('10.1038/nature02744');
		expect(normaliseDoi('doi:10.1000/xyz')).toBe('10.1000/xyz');
		expect(normaliseDoi('not a doi')).toBeNull();
		expect(doiPath('10.1002/(sici)1097#x')).toBe('10.1002/(sici)1097%23x');
	});

	it('finds an arXiv id in an id, an arXiv DOI or an address, without the version', () => {
		expect(arxivIdFrom('2101.00001v3')).toBe('2101.00001');
		expect(arxivIdFrom('10.48550/arXiv.2101.00001')).toBe('2101.00001');
		expect(arxivIdFrom('https://arxiv.org/pdf/2101.00001v2')).toBe('2101.00001');
		expect(arxivIdFrom('https://arxiv.org/abs/hep-th/9901001')).toBe('hep-th/9901001');
		expect(arxivIdFrom('https://example.org/paper')).toBeNull();
	});

	it('finds a PMCID', () => {
		expect(pmcidFrom('https://www.ncbi.nlm.nih.gov/pmc/articles/pmc123456')).toBe('PMC123456');
		expect(pmcidFrom(null)).toBeNull();
	});
});

describe('openAccessLocations', () => {
	it('keeps only open copies, once each, repositories and PDFs first', () => {
		expect(
			openAccessLocations([
				{ is_oa: true, landing_page_url: 'https://publisher.example/a', source: { type: 'journal', display_name: 'J' } },
				{ is_oa: false, pdf_url: 'https://closed.example/a.pdf' },
				{ is_oa: true, pdf_url: 'https://repo.example/a.pdf', source: { type: 'repository', display_name: 'Repo' } },
				{ is_oa: true, pdf_url: 'https://repo.example/a.pdf', source: { type: 'repository', display_name: 'Repo' } }
			]).map((l) => [l.url, l.repository])
		).toEqual([
			['https://repo.example/a.pdf', true],
			['https://publisher.example/a', false]
		]);
	});
});

describe('jatsToText', () => {
	it('keeps the title, abstract and section headings, and leaves out references', () => {
		const text = jatsToText(`<article><front><article-meta><title-group><article-title>Kin &amp; iron</article-title></title-group>
			<abstract><p>Relatedness favours <italic>cooperation</italic>.</p></abstract></article-meta></front>
			<body><sec><title>Methods</title><p>We grew P.&#160;aeruginosa<xref ref-type="bibr">[3]</xref>.</p></sec></body>
			<back><ref-list><ref>Hamilton 1964</ref></ref-list></back></article>`);
		expect(text).toBe('# Kin & iron\n\n## Abstract\n\nRelatedness favours cooperation.\n\n## Methods\n\nWe grew P. aeruginosa[3].');
		expect(text).not.toContain('Hamilton');
	});
});

describe('keyed sources', () => {
	it('skips CORE and Semantic Scholar without a key, without calling them', async () => {
		const { impl, asked } = routedFetch([]);
		expect(await coreFullText('10.1/x', { ...CFG, fetchImpl: impl })).toEqual({
			ok: false,
			reason: 'skipped, no API key (Admin → Settings → Shelf)'
		});
		expect((await semanticScholarPaper('10.1/x', { ...CFG, fetchImpl: impl })).ok).toBe(false);
		expect(asked).toEqual([]);
	});

	it('sends each key the way its API wants it', async () => {
		const { impl, asked } = routedFetch([
			['api.core.ac.uk', () => new Response(JSON.stringify({ results: [{ fullText: 'short' }, { fullText: 'the longer one' }] }))],
			['api.semanticscholar.org', () => new Response(JSON.stringify({ openAccessPdf: { url: 'https://x/y.pdf' } }))]
		]);
		const cfg = { ...CFG, coreKey: 'ck', s2Key: 'sk', fetchImpl: impl };
		expect(await coreFullText('10.1/x', cfg)).toEqual({ ok: true, value: 'the longer one' });
		expect(await semanticScholarPaper('10.1/x', cfg)).toMatchObject({ ok: true });
		expect(asked[0].headers.get('authorization')).toBe('Bearer ck');
		expect(asked[1].headers.get('x-api-key')).toBe('sk');
	});
});

describe('crossrefAuthors', () => {
	it('names authors from given and family names, or an organisation name', async () => {
		const { impl } = routedFetch([
			[
				'api.crossref.org/works/10.1/twins',
				() => new Response(JSON.stringify({ message: { author: [{ given: 'Ada', family: 'Lovelace' }, { name: 'Twin Registry Group' }] } }))
			]
		]);
		expect(await crossrefAuthors('10.1/twins', { ...CFG, fetchImpl: impl })).toEqual({
			ok: true,
			value: ['Ada Lovelace', 'Twin Registry Group']
		});
	});
});
