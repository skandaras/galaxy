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
		e.pinned ? 'pinned' : '',
		e.sensitivity === 'private' ? 'private' : '',
		e.source === 'inferred' ? 'inferred' : '',
		e.expiresAt ? `until ${e.expiresAt.slice(0, 10)}` : ''
	].filter(Boolean);
}

export type ProposalAction = 'add' | 'update' | 'retire' | 'confirm';

/** What a proposal is called on the page, and what its two buttons say. */
export function proposalWords(action: ProposalAction): {
	badge: string;
	yes: string;
	no: string;
	editable: boolean;
} {
	switch (action) {
		case 'add':
			return { badge: 'New', yes: 'Approve', no: 'Reject', editable: true };
		case 'update':
			return { badge: 'Change', yes: 'Approve', no: 'Reject', editable: true };
		case 'retire':
			return { badge: 'Retire', yes: 'Retire it', no: 'Keep it', editable: false };
		case 'confirm':
			return { badge: 'Still true?', yes: 'Still true', no: 'Not any more', editable: false };
	}
}

/** `people/Nikau` as the page writes a place: "people / Nikau". */
export const placeLabel = (path: string | null | undefined) => (path ?? '').replace('/', ' / ');

export interface ReadingView {
	running: boolean;
	done: number;
	total: number;
	proposals: number;
	failed: number;
	stopped?: string;
}

/** Where reading past conversations has got to, or how the last reading ended when it went wrong. */
export function readingText(r: ReadingView | null): { text: string; error: boolean } | null {
	if (!r) return null;
	const batches = `${r.total} ${r.total === 1 ? 'batch' : 'batches'}`;
	if (r.running) {
		return {
			text: `Reading your past conversations: ${r.done} of ${batches}, ${r.proposals} proposed so far.`,
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
