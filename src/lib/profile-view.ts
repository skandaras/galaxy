/**
 * The Profile page's arithmetic, kept out of the component so it can be tested
 * without a DOM.
 */

export interface ViewSubdomain {
	name: string;
	label: string;
	entries: unknown[];
}

export interface ViewDomain {
	domain: string;
	subdomains: ViewSubdomain[];
}

/**
 * Where something can be filed, as the add form offers it: every subdomain,
 * with a person's card by name. The value is the path the API resolves, so a
 * card is addressed by the name the person sees rather than an opaque id.
 */
export function pathOptions(domains: ViewDomain[]): { value: string; label: string }[] {
	return domains.flatMap(({ domain, subdomains }) =>
		subdomains.map((s) => ({
			value: `${domain}/${domain === 'people' ? s.label : s.name}`,
			label: `${domain} / ${s.label}`
		}))
	);
}

/** "Brief: 975 of 2,400 characters", and how full that is, for the meter. */
export function briefUsage(used: number, budget: number): { text: string; full: number } {
	const full = budget > 0 ? Math.min(1, used / budget) : 1;
	return {
		text: `Brief: ${used.toLocaleString('en-NZ')} of ${budget.toLocaleString('en-NZ')} characters`,
		full
	};
}

/** The labels an entry carries on the page, in the order they are read. */
export function entryMarks(e: {
	pinned: boolean;
	sensitivity: string;
	source: string;
	expiresAt: string | null;
}): string[] {
	return [
		e.pinned ? 'always in brief' : '',
		e.sensitivity === 'private' ? 'private' : '',
		e.source === 'inferred' ? 'inferred' : '',
		e.expiresAt ? `until ${e.expiresAt.slice(0, 10)}` : ''
	].filter(Boolean);
}

export type LearnedAction = 'add' | 'update' | 'retire';

/** What a learned change is called on the page, what its undo says, and what undoing it reports. */
export function learnedWords(action: LearnedAction): { badge: string; undo: string; done: string } {
	switch (action) {
		case 'add':
			return { badge: 'New', undo: 'Undo', done: 'Taken back. It will not be learned again.' };
		case 'update':
			return { badge: 'Changed', undo: 'Undo', done: 'Put back as it was.' };
		case 'retire':
			return { badge: 'Retired', undo: 'Bring it back', done: 'Back in your profile.' };
	}
}

/** `people/Nikau` as the page writes a place: "people / Nikau". */
export const placeLabel = (path: string | null | undefined) => (path ?? '').replace('/', ' / ');

export interface ReadingView {
	running: boolean;
	done: number;
	total: number;
	learned: number;
	failed: number;
	stopped?: string;
}

/** Where reading past conversations has got to, or how the last reading ended when it went wrong. */
export function readingText(r: ReadingView | null): { text: string; error: boolean } | null {
	if (!r) return null;
	const batches = `${r.total} ${r.total === 1 ? 'batch' : 'batches'}`;
	if (r.running) {
		return {
			text: `Reading your past conversations: ${r.done} of ${batches}, ${r.learned} learned so far.`,
			error: false
		};
	}
	if (!r.stopped && !r.failed) return null;
	const failed = r.failed ? `, and ${r.failed} of its ${batches} could not be read` : '';
	return {
		text: `The last reading ${r.stopped ? `stopped early: ${r.stopped}` : 'finished'}${failed}.`,
		error: true
	};
}
