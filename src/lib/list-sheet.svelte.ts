/**
 * The way in and out of a page's own list on a phone.
 *
 * Chat, Code and Library each grew their own floating ☰ and their own
 * off-canvas drawer, and the three CSS blocks were byte-identical down to the
 * 0.55rem offset. All three also shared the same three omissions: no scrim, so
 * the uncovered strip of the page looked like a dismiss target and was not; no
 * Escape; and no way back out with the thumb that opened it.
 */

/** How far a drag has to travel before it means "put this away". */
export const SWIPE_CLOSE_PX = 48;

export interface Point {
	x: number;
	y: number;
}

/**
 * The sheet slides in from the left, so dismissing it is a leftward drag.
 *
 * The second half of the test is the one that matters: a drag that travels
 * further down than sideways is someone scrolling the list, and closing the
 * sheet under them loses the row they were reaching for.
 */
export function isDismissSwipe(from: Point, to: Point, threshold = SWIPE_CLOSE_PX): boolean {
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	return dx < -threshold && Math.abs(dx) > Math.abs(dy);
}

/**
 * Whichever page is mounted registers its list here, so the tab bar can open it
 * when you tap the tab you are already on — the second way in, for a thumb that
 * is already at the bottom of the screen.
 *
 * A single slot rather than a set: one page is mounted at a time, and a stale
 * registration from a page that has gone would open nothing.
 */
let opener = $state<(() => void) | null>(null);

export const pageList = {
	/** False on a page with no list, where the tab tap should just navigate. */
	get present() {
		return opener !== null;
	},
	toggle() {
		opener?.();
	}
};

export function registerPageList(fn: () => void): () => void {
	opener = fn;
	return () => {
		// Only clear if it is still ours. Svelte mounts the incoming page before
		// unmounting the outgoing one, so an unconditional clear on teardown
		// would wipe the registration the new page just made.
		if (opener === fn) opener = null;
	};
}
