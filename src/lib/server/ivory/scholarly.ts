/**
 * The scholarly APIs Ivory Tower reads from, beyond OpenAlex's search.
 *
 * Each call answers with what it found or with why it could not, rather than
 * throwing, because the full-text reader tries several of them in turn and
 * has to tell the model exactly which ones failed and how. All of them are
 * fixed hosts, so nothing here goes through the SSRF guard; addresses taken
 * *from* their answers (a PDF link, a repository copy) do, in fulltext.ts.
 */

export interface ScholarlyConfig {
	/** Contact address for the polite pools (OpenAlex, Crossref). Optional. */
	mailto: string;
	coreKey: string;
	s2Key: string;
	timeoutMs: number;
	fetchImpl?: typeof fetch;
}

export type Got<T> = { ok: true; value: T } | { ok: false; reason: string };

async function get(
	cfg: ScholarlyConfig,
	url: string | URL,
	headers: Record<string, string> = {}
): Promise<Got<Response>> {
	try {
		const res = await (cfg.fetchImpl ?? fetch)(url, {
			headers: {
				'user-agent': cfg.mailto ? `galaxy (mailto:${cfg.mailto})` : 'galaxy',
				...headers
			},
			signal: AbortSignal.timeout(cfg.timeoutMs)
		});
		if (res.status === 404) return { ok: false, reason: 'not found' };
		if (res.status === 429) return { ok: false, reason: 'rate-limited (HTTP 429)' };
		if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
		return { ok: true, value: res };
	} catch (err) {
		return { ok: false, reason: err instanceof Error && err.name === 'TimeoutError' ? 'timed out' : String(err) };
	}
}

async function getJson<T>(cfg: ScholarlyConfig, url: string | URL, headers: Record<string, string> = {}): Promise<Got<T>> {
	const res = await get(cfg, url, { accept: 'application/json', ...headers });
	if (!res.ok) return res;
	const body = (await res.value.json().catch(() => null)) as T | null;
	return body === null ? { ok: false, reason: 'unreadable response' } : { ok: true, value: body };
}

/** A bare, lower-case DOI from a DOI, a doi: string or a doi.org URL; null for anything else. */
export function normaliseDoi(raw: string | null | undefined): string | null {
	const s = String(raw ?? '')
		.trim()
		.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
		.replace(/^doi:\s*/i, '')
		.toLowerCase();
	return /^10\.\d{4,9}\/\S+$/.test(s) ? s : null;
}

/**
 * A DOI for a URL path. DOIs may hold `#`, `;` or `<`, which would end or break
 * the path; the slash after the prefix is what every API expects to see.
 */
export function doiPath(doi: string): string {
	return doi.split('/').map(encodeURIComponent).join('/');
}

/** An arXiv id from an id, an arXiv DOI or an arxiv.org address, without its version. */
export function arxivIdFrom(raw: string | null | undefined): string | null {
	const s = String(raw ?? '').trim();
	const m =
		/^(?:arxiv:)?(\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?$/i.exec(s) ??
		/10\.48550\/arxiv\.(\d{4}\.\d{4,5})/i.exec(s) ??
		/arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})/i.exec(s);
	return m ? m[1] : null;
}

/** `PMC123456` from an id or a PMC article address. */
export function pmcidFrom(raw: string | null | undefined): string | null {
	const m = /PMC\d+/i.exec(String(raw ?? ''));
	return m ? m[0].toUpperCase() : null;
}

// ---------------------------------------------------------------------------
// OpenAlex, one work by DOI

export interface OaLocation {
	url: string;
	isPdf: boolean;
	/** A repository copy (PMC, arXiv, a university archive) rather than the publisher's. */
	repository: boolean;
	name: string;
}

export interface WorkRecord {
	pmcid: string | null;
	arxivId: string | null;
	authors: string[];
	locations: OaLocation[];
}

interface OpenAlexLocation {
	is_oa?: boolean;
	landing_page_url?: string | null;
	pdf_url?: string | null;
	source?: { type?: string | null; display_name?: string | null } | null;
}

interface OpenAlexWorkDetail {
	ids?: { pmcid?: string | null };
	authorships?: { author?: { display_name?: string } }[];
	locations?: OpenAlexLocation[];
}

/** The open copies OpenAlex knows of, repositories first, each once. */
export function openAccessLocations(locations: OpenAlexLocation[] | undefined): OaLocation[] {
	const out: OaLocation[] = [];
	const seen = new Set<string>();
	for (const l of locations ?? []) {
		if (!l.is_oa) continue;
		const url = l.pdf_url || l.landing_page_url;
		if (!url || seen.has(url)) continue;
		seen.add(url);
		out.push({
			url,
			isPdf: !!l.pdf_url,
			repository: l.source?.type === 'repository',
			name: l.source?.display_name || new URL(url).hostname
		});
	}
	// Stable sort: repository copies first, a PDF before a landing page.
	return out.sort((a, b) => Number(b.repository) - Number(a.repository) || Number(b.isPdf) - Number(a.isPdf));
}

export function workFromOpenAlex(w: OpenAlexWorkDetail & { doi?: string | null }): WorkRecord {
	const locations = openAccessLocations(w.locations);
	return {
		pmcid: pmcidFrom(w.ids?.pmcid),
		arxivId:
			arxivIdFrom(w.doi) ??
			(w.locations ?? []).map((l) => arxivIdFrom(l.pdf_url) ?? arxivIdFrom(l.landing_page_url)).find(Boolean) ??
			null,
		authors: (w.authorships ?? []).map((a) => a.author?.display_name ?? '').filter(Boolean),
		locations
	};
}

export async function openAlexWork(doi: string, cfg: ScholarlyConfig): Promise<Got<WorkRecord>> {
	const url = new URL(`https://api.openalex.org/works/doi:${doiPath(doi)}`);
	url.searchParams.set('select', 'doi,ids,authorships,locations');
	if (cfg.mailto) url.searchParams.set('mailto', cfg.mailto);
	const got = await getJson<OpenAlexWorkDetail & { doi?: string }>(cfg, url);
	return got.ok ? { ok: true, value: workFromOpenAlex(got.value) } : got;
}

// ---------------------------------------------------------------------------
// Europe PMC

const EPMC = 'https://www.ebi.ac.uk/europepmc/webservices/rest';

/** The PMCID for a DOI, when Europe PMC holds the article's full text. */
export async function europePmcId(doi: string, cfg: ScholarlyConfig): Promise<Got<string>> {
	const url = new URL(`${EPMC}/search`);
	url.searchParams.set('query', `DOI:"${doi}"`);
	url.searchParams.set('format', 'json');
	url.searchParams.set('resultType', 'lite');
	const got = await getJson<{ resultList?: { result?: { pmcid?: string; isOpenAccess?: string; inEPMC?: string }[] } }>(
		cfg,
		url
	);
	if (!got.ok) return got;
	const hit = got.value.resultList?.result?.find((r) => r.pmcid && (r.isOpenAccess === 'Y' || r.inEPMC === 'Y'));
	return hit?.pmcid ? { ok: true, value: hit.pmcid } : { ok: false, reason: 'not in its open-access full-text set' };
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s: string): string {
	return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, e: string) => {
		if (e[0] === '#') {
			const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
			return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
		}
		return ENTITIES[e.toLowerCase()] ?? whole;
	});
}

/**
 * JATS XML (PubMed Central's article format) to readable text: the title, the
 * abstract and the body with its section headings. The reference list is left
 * out; it is long, and nothing in it can be quoted as the paper's own claim.
 */
export function jatsToText(xml: string): string {
	const inner = (tag: string) => new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(xml)?.[1] ?? '';
	const flatten = (s: string) =>
		decodeEntities(
			s
				.replace(/<(table-wrap|ref-list|fn-group|supplementary-material)\b[\s\S]*?<\/\1>/gi, '')
				.replace(/<title\b[^>]*>([\s\S]*?)<\/title>/gi, (_m, t: string) => `\n\n## ${t.replace(/<[^>]+>/g, '').trim()}\n\n`)
				.replace(/<\/(p|caption|list-item)>/gi, '\n\n')
				.replace(/<[^>]+>/g, '')
		)
			.split('\n')
			.map((l) => l.replace(/[ \t]+/g, ' ').trim())
			.join('\n')
			.replace(/\n{3,}/g, '\n\n')
			.trim();
	const title = flatten(inner('article-title'));
	const abstract = flatten(inner('abstract'));
	const body = flatten(inner('body'));
	return [title && `# ${title}`, abstract && `## Abstract\n\n${abstract}`, body].filter(Boolean).join('\n\n');
}

export async function europePmcFullText(pmcid: string, cfg: ScholarlyConfig): Promise<Got<string>> {
	const res = await get(cfg, `${EPMC}/${pmcid}/fullTextXML`, { accept: 'application/xml' });
	if (!res.ok) return res;
	const text = jatsToText(await res.value.text());
	return text ? { ok: true, value: text } : { ok: false, reason: 'the article XML held no text' };
}

// ---------------------------------------------------------------------------
// CORE

export async function coreFullText(doi: string, cfg: ScholarlyConfig): Promise<Got<string>> {
	if (!cfg.coreKey) return { ok: false, reason: 'skipped, no API key (Admin → Settings → Shelf)' };
	const url = new URL('https://api.core.ac.uk/v3/search/works');
	url.searchParams.set('q', `doi:"${doi}"`);
	url.searchParams.set('limit', '5');
	const got = await getJson<{ results?: { fullText?: string | null }[] }>(cfg, url, {
		authorization: `Bearer ${cfg.coreKey}`
	});
	if (!got.ok) return got;
	const best = (got.value.results ?? [])
		.map((r) => (r.fullText ?? '').trim())
		.sort((a, b) => b.length - a.length)[0];
	return best ? { ok: true, value: best } : { ok: false, reason: 'no repository full text for this DOI' };
}

// ---------------------------------------------------------------------------
// Semantic Scholar

const S2 = 'https://api.semanticscholar.org/graph/v1';

export interface S2Paper {
	paperId?: string;
	title?: string | null;
	year?: number | null;
	abstract?: string | null;
	url?: string | null;
	authors?: { name?: string }[];
	externalIds?: { DOI?: string; ArXiv?: string; PubMedCentral?: string } | null;
	openAccessPdf?: { url?: string | null } | null;
}

function s2Headers(cfg: ScholarlyConfig): Record<string, string> {
	return cfg.s2Key ? { 'x-api-key': cfg.s2Key } : {};
}

export async function semanticScholarPaper(doi: string, cfg: ScholarlyConfig): Promise<Got<S2Paper>> {
	if (!cfg.s2Key) return { ok: false, reason: 'skipped, no API key (Admin → Settings → Shelf)' };
	const url = new URL(`${S2}/paper/DOI:${doiPath(doi)}`);
	url.searchParams.set('fields', 'openAccessPdf,externalIds,authors');
	return getJson<S2Paper>(cfg, url, s2Headers(cfg));
}

export async function semanticScholarSearch(
	query: string,
	cfg: ScholarlyConfig,
	opts: { limit: number; fromYear?: number }
): Promise<Got<S2Paper[]>> {
	const url = new URL(`${S2}/paper/search`);
	url.searchParams.set('query', query);
	url.searchParams.set('limit', String(opts.limit));
	url.searchParams.set('fields', 'title,authors,year,abstract,externalIds,openAccessPdf,url');
	if (opts.fromYear) url.searchParams.set('year', `${opts.fromYear}-`);
	const got = await getJson<{ data?: S2Paper[] }>(cfg, url, s2Headers(cfg));
	if (!got.ok) return got;
	return Array.isArray(got.value.data) ? { ok: true, value: got.value.data } : { ok: false, reason: 'unreadable response' };
}

// ---------------------------------------------------------------------------
// Crossref

/** Authors as Crossref records them, for works whose search record has none. */
export async function crossrefAuthors(doi: string, cfg: ScholarlyConfig): Promise<Got<string[]>> {
	const url = new URL(`https://api.crossref.org/works/${doiPath(doi)}`);
	if (cfg.mailto) url.searchParams.set('mailto', cfg.mailto);
	const got = await getJson<{ message?: { author?: { given?: string; family?: string; name?: string }[] } }>(cfg, url);
	if (!got.ok) return got;
	const authors = (got.value.message?.author ?? [])
		.map((a) => a.name ?? [a.given, a.family].filter(Boolean).join(' '))
		.map((a) => a.trim())
		.filter(Boolean);
	return authors.length ? { ok: true, value: authors } : { ok: false, reason: 'no authors recorded' };
}
