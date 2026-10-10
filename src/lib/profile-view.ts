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
