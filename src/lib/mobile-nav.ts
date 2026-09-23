/**
 * Which destinations get a tab of their own in the phone's bottom bar.
 *
 * The rail's link list is conditional — Code is a per-user grant, Alignment is
 * off by default, Admin depends on the group — so it holds between five and
 * nine entries and something always overflows. Promotion is decided by a fixed
 * priority rather than by position in that list, because a tab that moves under
 * someone's thumb the day they are made an admin is worse than one that was
 * never there.
 */

export interface NavLink {
	href: string;
	label: string;
}

export interface NavSplit {
	tabs: NavLink[];
	more: NavLink[];
}

/** Destinations with a tab of their own. The fifth slot is always "More". */
export const TAB_SLOTS = 4;

/**
 * Promotion order. Admin and Observatory sit at the bottom deliberately: both
 * appear for some people and not others, and neither may displace a tab the
 * rest of the interface has taught.
 */
const PRIORITY = [
	'/chat',
	'/code',
	'/boards',
	'/library',
	'/cortex',
	'/alignment',
	'/settings',
	'/admin',
	'/observatory'
];

/**
 * A destination the rail gains later but this file has not been told about
 * still appears — in More, after everything named, keeping its incoming order.
 * The alternative is a link that silently vanishes on phones.
 */
function rank(href: string): number {
	const i = PRIORITY.indexOf(href);
	return i === -1 ? PRIORITY.length : i;
}

export function splitNav(links: NavLink[]): NavSplit {
	// Array.prototype.sort is stable, which is what keeps two unranked links in
	// the order the rail gave them.
	const ranked = [...links].sort((a, b) => rank(a.href) - rank(b.href));
	return { tabs: ranked.slice(0, TAB_SLOTS), more: ranked.slice(TAB_SLOTS) };
}

/**
 * Restrained geometric glyphs rather than emoji: the rest of the interface
 * draws with ✦ ◉ ■ ▸ ✓, and a colour emoji in the middle of that reads as a
 * mistake. Every label is rendered underneath, so these disambiguate rather
 * than carry the meaning on their own.
 */
const GLYPHS: Record<string, string> = {
	'/chat': '◈',
	'/code': '❯',
	'/boards': '▦',
	'/library': '▤',
	'/cortex': '✧',
	'/alignment': '◉',
	'/settings': '⚙',
	'/admin': '▩',
	'/observatory': '◎'
};

/** The overflow tab's own glyph, which belongs to no destination. */
export const MORE_GLYPH = '⋯';

export function navGlyph(href: string): string {
	return GLYPHS[href] ?? '•';
}

/** Exported for the test that keeps GLYPHS and PRIORITY from drifting apart. */
export const KNOWN_HREFS: readonly string[] = PRIORITY;
