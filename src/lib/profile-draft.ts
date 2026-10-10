import {
	DOMAINS,
	LIMITS,
	PATH_SENSITIVITY,
	type EntityKind,
	type Kind,
	type Sensitivity
} from './profile-taxonomy';

/**
 * Profile entries nothing has written yet.
 *
 * The survey, a memory pasted from another assistant and the Profile's own
 * export each arrive as one of these, so one review edits all three and one
 * route saves them. Only that route writes: the person reads every line before
 * any agent does.
 *
 * No server imports: the review runs in the browser.
 */

export interface DraftPerson {
	name: string;
	kind: EntityKind;
	relation: string;
	aka: string[];
}

export interface DraftEntry {
	/** `work/tools`, `people/Aroha`, or a subdomain of their own that saving creates. */
	path: string;
	kind: Kind;
	claim: string;
	pinned: boolean;
	/** The day it stops being true, `YYYY-MM-DD`, as the page's "True until" takes it. */
	until: string | null;
	/** Who it is about, by name: someone in the draft or already in the profile. */
	about: string | null;
	/** Only an export carries one, and only where it differs from the path's usual. */
	sensitivity: Sensitivity | null;
}

export interface Draft {
	people: DraftPerson[];
	entries: DraftEntry[];
	/** Lines about how an assistant should reply, kept out so they can go to platform settings. */
	notCarried: string[];
	/** What reading the text left out, and why, a sentence each. */
	leftOut: string[];
}

/** Free text for the parse call, with what it was an answer to. */
export interface ParsePart {
	label: string;
	/** The domain or path the answer is mostly about; the model may file elsewhere. */
	about: string;
	text: string;
}

export const emptyDraft = (): Draft => ({ people: [], entries: [], notCarried: [], leftOut: [] });

/** Two drafts as one. Someone named twice is kept once, as first given. */
export function mergeDrafts(a: Draft, b: Draft): Draft {
	const seen = new Set<string>();
	const people = [...a.people, ...b.people].filter((p) => {
		const key = p.name.trim().toLowerCase();
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	return {
		people,
		entries: [...a.entries, ...b.entries],
		notCarried: [...a.notCarried, ...b.notCarried],
		leftOut: [...a.leftOut, ...b.leftOut]
	};
}

export interface DraftPath {
	value: string;
	label: string;
	sensitivity: Sensitivity;
	/** Saving creates it: a subdomain of their own, or someone not yet in the profile. */
	isNew: boolean;
}

/** The profile's places as `/api/profile` lays them out. */
export interface ViewDomain {
	domain: string;
	subdomains: { name: string; label: string; sensitivity?: Sensitivity }[];
}

/**
 * Everywhere a draft line can be filed: the profile's own places, people the
 * draft adds, and any new subdomain a line already names. A new one is marked,
 * because saving creates it and it counts against the four a domain allows.
 */
export function draftPaths(domains: ViewDomain[], draft: Draft): DraftPath[] {
	const out: DraftPath[] = [];
	const has = (value: string) => out.some((o) => o.value.toLowerCase() === value.toLowerCase());
	for (const { domain, subdomains } of domains) {
		for (const s of subdomains) {
			const value = `${domain}/${domain === 'people' ? s.label : s.name}`;
			out.push({
				value,
				label: `${domain} / ${s.label}`,
				sensitivity: s.sensitivity ?? pathSensitivity(value),
				isNew: false
			});
		}
	}
	for (const p of draft.people) {
		const value = `people/${p.name.trim()}`;
		if (p.name.trim() && !has(value)) {
			out.push({ value, label: `people / ${p.name.trim()}`, sensitivity: 'personal', isNew: true });
		}
	}
	for (const e of draft.entries) {
		if (!e.path || has(e.path)) continue;
		const [domain, sub] = e.path.split('/');
		if (!(DOMAINS as readonly string[]).includes(domain) || !sub) continue;
		out.push({
			value: e.path,
			label: `${domain} / ${sub}`,
			sensitivity: pathSensitivity(e.path),
			isNew: true
		});
	}
	return out;
}

/** What a path makes an entry filed there, before the person changes it. */
export function pathSensitivity(path: string): Sensitivity {
	if (path.startsWith('people/')) return 'personal';
	return PATH_SENSITIVITY[path] ?? 'normal';
}

/**
 * What is wrong with each line, said beside it before anything is sent. The
 * store checks all of it again; this saves a round trip per mistake.
 */
export function draftProblems(
	draft: Draft,
	today: string
): { people: (string | null)[]; entries: (string | null)[] } {
	const people = draft.people.map((p) => {
		const name = p.name.trim();
		if (!name || name.length > LIMITS.nameMax) return `A name is 1 to ${LIMITS.nameMax} characters.`;
		if (p.relation.trim().length > LIMITS.relationMax) {
			return `A relation is at most ${LIMITS.relationMax} characters.`;
		}
		return null;
	});
	const entries = draft.entries.map((e) => {
		const n = e.claim.replace(/\s+/g, ' ').trim().length;
		if (n < LIMITS.claimMin || n > LIMITS.claimMax) {
			return `A line is ${LIMITS.claimMin} to ${LIMITS.claimMax} characters; this one is ${n}.`;
		}
		if (!e.path) return 'Choose where it goes.';
		if (e.until && e.until <= today) return 'That date has passed.';
		if (e.pinned && (e.sensitivity ?? pathSensitivity(e.path)) === 'private') {
			return 'A private line cannot be pinned: the brief reaches every agent.';
		}
		return null;
	});
	return { people, entries };
}
