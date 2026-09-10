import { describe, expect, it } from 'vitest';
import { KNOWN_HREFS, navGlyph, splitNav, TAB_SLOTS, type NavLink } from './mobile-nav';

/** The rail as +layout.svelte builds it for the plainest account. */
const BASE: NavLink[] = [
	{ href: '/chat', label: 'Chat' },
	{ href: '/boards', label: 'Boards' },
	{ href: '/library', label: 'Library' },
	{ href: '/cortex', label: 'Cortex' },
	{ href: '/settings', label: 'Settings' },
	{ href: '/observatory', label: 'Observatory' }
];

const withCode: NavLink[] = [
	{ href: '/chat', label: 'Chat' },
	{ href: '/code', label: 'Code' },
	...BASE.slice(1)
];

const hrefs = (links: NavLink[]) => links.map((l) => l.href);

describe('splitNav', () => {
	it('fills the tabs by priority, not by the order the rail gave', () => {
		const { tabs, more } = splitNav(BASE);
		expect(hrefs(tabs)).toEqual(['/chat', '/boards', '/library', '/cortex']);
		expect(hrefs(more)).toEqual(['/settings', '/observatory']);
	});

	it('gives Code a tab when the grant is there, and Cortex the seat it took', () => {
		const { tabs, more } = splitNav(withCode);
		expect(hrefs(tabs)).toEqual(['/chat', '/code', '/boards', '/library']);
		expect(more.some((l) => l.href === '/cortex')).toBe(true);
	});

	it('does not move a single tab when someone is made an admin', () => {
		// The whole reason promotion is by priority rather than by position: the
		// day an account gains Admin, the four things its thumb has learned have
		// to still be under the thumb.
		const before = splitNav(withCode).tabs;
		const after = splitNav([...withCode, { href: '/admin', label: 'Admin' }]).tabs;
		expect(hrefs(after)).toEqual(hrefs(before));
	});

	it('does not move a tab when Alignment is switched on either', () => {
		const before = splitNav(BASE).tabs;
		const after = splitNav([...BASE, { href: '/alignment', label: 'Alignment' }]).tabs;
		expect(hrefs(after)).toEqual(hrefs(before));
	});

	it('always leaves Settings reachable', () => {
		for (const links of [BASE, withCode, [...withCode, { href: '/admin', label: 'Admin' }]]) {
			const { tabs, more } = splitNav(links);
			expect([...tabs, ...more].some((l) => l.href === '/settings')).toBe(true);
		}
	});

	it('keeps a destination this file has never heard of, at the end of More', () => {
		// A link added to the rail later must not silently vanish on phones.
		const { tabs, more } = splitNav([...BASE, { href: '/telescope', label: 'Telescope' }]);
		expect(hrefs(tabs)).not.toContain('/telescope');
		expect(hrefs(more).at(-1)).toBe('/telescope');
	});

	it('takes a short list without inventing a More bucket', () => {
		const short = BASE.slice(0, 3);
		const { tabs, more } = splitNav(short);
		expect(tabs).toHaveLength(3);
		expect(more).toEqual([]);
	});

	it('never promotes more than the bar has room for', () => {
		const everything = [...withCode, { href: '/alignment', label: 'A' }, { href: '/admin', label: 'B' }];
		expect(splitNav(everything).tabs).toHaveLength(TAB_SLOTS);
	});

	it('leaves the caller’s array alone', () => {
		const input = [...BASE];
		splitNav(input);
		expect(hrefs(input)).toEqual(hrefs(BASE));
	});
});

describe('navGlyph', () => {
	it('has a glyph for every destination the priority list names', () => {
		// Adding a destination to PRIORITY without adding its glyph would ship a
		// bullet in the bottom bar; this is the check that catches it.
		for (const href of KNOWN_HREFS) {
			expect(navGlyph(href)).not.toBe('•');
		}
	});

	it('falls back rather than rendering nothing', () => {
		expect(navGlyph('/telescope')).toBe('•');
	});

	it('gives each destination a distinct glyph', () => {
		const seen = KNOWN_HREFS.map(navGlyph);
		expect(new Set(seen).size).toBe(seen.length);
	});
});
