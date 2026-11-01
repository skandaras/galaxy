import { fetchPageContent, PageFetchError } from '$lib/server/engine/research';
import {
	arxivIdFrom,
	coreFullText,
	europePmcFullText,
	europePmcId,
	normaliseDoi,
	openAlexWork,
	pmcidFrom,
	semanticScholarPaper,
	type Got,
	type ScholarlyConfig,
	type WorkRecord
} from './scholarly';

/**
 * Finding a paper's full text, when one is legitimately open.
 *
 * The reader used to have fetch_url and the one "best" open-access link from
 * search, and most runs ended abstract-only. That link is often the
 * publisher's copy, which answers automated requests with a 403 or a bot
 * check, and the same paper is often sitting in PubMed Central, on arXiv or in
 * a university repository with no such wall. So this goes to the APIs that
 * hand over text first (Europe PMC, CORE), then to the repository copies, and
 * only then to publishers.
 *
 * A bot check is treated as a failure like any other and the next source is
 * tried. It is never retried or worked around. Paywalled papers with no open
 * copy anywhere stay abstract-only, and the attempts say so.
 */

export interface PaperRef {
	doi?: string | null;
	arxiv?: string | null;
	pmcid?: string | null;
}

export interface Attempt {
	source: string;
	outcome: string;
}

export type FullTextResult =
	| { ok: true; text: string; source: string; locator: string; attempts: Attempt[] }
	| { ok: false; attempts: Attempt[] };

/** A whole paper, with room for a long one. Paged out to the model in parts. */
export const FULL_TEXT_CHARS = 150_000;
/** Less than this is an abstract, a landing page or a stub, not a paper. */
export const MIN_FULL_TEXT_CHARS = 3_000;
/** At most this many open-access copies are tried from OpenAlex's list. */
const MAX_LOCATIONS = 4;

const BOT_CHECK =
	/just a moment\.\.\.|checking your browser|enable javascript and cookies|verify (that )?you are (a )?human|are you a robot|captcha|cf-browser-verification|access denied|unusual traffic/i;

/**
 * Why a text is not a paper, or null when it is. The bot-check markers are
 * only looked for in short texts: a real paper may well mention a captcha.
 */
export function unusable(text: string): string | null {
	if (text.length < 20_000 && BOT_CHECK.test(text.slice(0, 4_000))) return 'a bot check, not the paper';
	if (text.length < MIN_FULL_TEXT_CHARS) return `only ${text.length} characters of text, not a full paper`;
	return null;
}

export interface FullTextDeps {
	/** Reads one address to text; the SSRF-guarded page reader unless replaced in tests. */
	pageText?: (url: string) => Promise<string>;
}

function describe(err: unknown): string {
	if (err instanceof PageFetchError) {
		if (err.status === 403) return 'refused (HTTP 403)';
		return err.message;
	}
	return err instanceof Error ? err.message : String(err);
}

export async function readFullText(ref: PaperRef, cfg: ScholarlyConfig, deps: FullTextDeps = {}): Promise<FullTextResult> {
	const pageText =
		deps.pageText ??
		(async (url: string) =>
			(await fetchPageContent(url, cfg.timeoutMs, { fetchImpl: cfg.fetchImpl, clipChars: FULL_TEXT_CHARS })).text);
	const attempts: Attempt[] = [];
	const doi = normaliseDoi(ref.doi);
	const tried = new Set<string>();

	/** Record an attempt; true when it produced a usable paper. */
	const take = (source: string, got: Got<string>, locator: string): FullTextResult | null => {
		if (!got.ok) {
			attempts.push({ source, outcome: got.reason });
			return null;
		}
		const text = got.value.slice(0, FULL_TEXT_CHARS);
		const why = unusable(text);
		if (why) {
			attempts.push({ source, outcome: why });
			return null;
		}
		attempts.push({ source, outcome: 'full text read' });
		return { ok: true, text, source, locator, attempts };
	};
	const fromPage = async (source: string, url: string): Promise<FullTextResult | null> => {
		if (tried.has(url)) return null;
		tried.add(url);
		let got: Got<string>;
		try {
			got = { ok: true, value: await pageText(url) };
		} catch (err) {
			got = { ok: false, reason: describe(err) };
		}
		return take(source, got, url);
	};

	let work: WorkRecord | null = null;
	if (doi) {
		const w = await openAlexWork(doi, cfg);
		if (w.ok) work = w.value;
		else attempts.push({ source: 'OpenAlex record', outcome: w.reason });
	}

	// 1. Europe PMC: PubMed Central's open-access articles, as structured text.
	let pmcid = pmcidFrom(ref.pmcid) ?? work?.pmcid ?? null;
	if (!pmcid && doi) {
		const found = await europePmcId(doi, cfg);
		if (found.ok) pmcid = found.value;
		else attempts.push({ source: 'Europe PMC', outcome: found.reason });
	}
	if (pmcid) {
		const hit = take('Europe PMC', await europePmcFullText(pmcid, cfg), pmcid);
		if (hit) return hit;
	}

	// 2. arXiv, whose programmatic host serves the PDF to anyone.
	let arxiv = arxivIdFrom(ref.arxiv) ?? arxivIdFrom(doi) ?? work?.arxivId ?? null;
	const tryArxiv = async (id: string) => {
		const hit = await fromPage('arXiv', `https://export.arxiv.org/pdf/${id}`);
		if (hit && hit.ok) return { ...hit, locator: `arXiv:${id}` };
		return null;
	};
	if (arxiv) {
		const hit = await tryArxiv(arxiv);
		if (hit) return hit;
	}

	if (doi) {
		// 3. CORE: university repositories, full text in the answer itself.
		const core = take('CORE', await coreFullText(doi, cfg), `CORE, doi:${doi}`);
		if (core) return core;

		// 4. Semantic Scholar's open-access PDF, and an arXiv id if it knows one.
		const s2 = await semanticScholarPaper(doi, cfg);
		if (!s2.ok) {
			attempts.push({ source: 'Semantic Scholar', outcome: s2.reason });
		} else {
			const s2Arxiv = arxivIdFrom(s2.value.externalIds?.ArXiv);
			if (s2Arxiv && !arxiv) {
				arxiv = s2Arxiv;
				const hit = await tryArxiv(s2Arxiv);
				if (hit) return hit;
			}
			const pdf = s2.value.openAccessPdf?.url;
			if (pdf) {
				const hit = await fromPage('Semantic Scholar', pdf);
				if (hit) return hit;
			} else {
				attempts.push({ source: 'Semantic Scholar', outcome: 'no open-access PDF' });
			}
		}
	}

	// 5. Every open copy OpenAlex lists, repositories before publishers.
	const locations = (work?.locations ?? []).filter((l) => !arxivIdFrom(l.url)).slice(0, MAX_LOCATIONS);
	for (const l of locations) {
		const hit = await fromPage(`${l.name}${l.repository ? ' (repository)' : ''}`, l.url);
		if (hit) return hit;
	}
	if (work && !work.locations.length) attempts.push({ source: 'OpenAlex', outcome: 'lists no open-access copy' });
	if (!doi && !arxiv && !pmcid) attempts.push({ source: 'lookup', outcome: 'no DOI, arXiv id or PMCID to look up' });

	return { ok: false, attempts };
}
