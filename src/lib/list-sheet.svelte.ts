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
 * The drag itself, on the sheet rather than beside it.
 *
 * The handlers used to sit on the scrim, where a plain tap already closes
 * everything — so the gesture described above existed in the predicate and in
 * this file's header and nowhere a thumb could reach it. "A way back out with
 * the thumb that opened it" was still the omission it was written to fix.
 */
export function swipeToClose(node: HTMLElement, close: () => void) {
	let from: Point | null = null;
	const down = (e: PointerEvent) => {
		from = { x: e.clientX, y: e.clientY };
	};
	const move = (e: PointerEvent) => {
		if (!from) return;
		if (!isDismissSwipe(from, { x: e.clientX, y: e.clientY })) return;
		// Consumed, so one drag closes once rather than firing for every
		// remaining pointermove of the same gesture.
		from = null;
		close();
	};
	const clear = () => {
		from = null;
	};
	node.addEventListener('pointerdown', down);
	node.addEventListener('pointermove', move);
	node.addEventListener('pointerup', clear);
	node.addEventListener('pointercancel', clear);
	return {
		destroy() {
			node.removeEventListener('pointerdown', down);
			node.removeEventListener('pointermove', move);
			node.removeEventListener('pointerup', clear);
			node.removeEventListener('pointercancel', clear);
		}
	};
}

/**
 * Whichever page is mounted registers its list here, so the tab bar can open it
 * when you tap the tab you are already on — the second way in, for a thumb that
 * is already at the bottom of the screen.
 *
 * A single slot rather than a set: one page is mounted at a time, and a stale
 * registration from a page that has gone would open nothing.
 */
let opener = $state<((open: boolean) => void) | null>(null);

export const pageList = {
	/** False on a page with no list, where the tab tap should just navigate. */
	get present() {
		return opener !== null;
	},
	/**
	 * Opens. Never closes — and that asymmetry is the whole point.
	 *
	 * This was a toggle, which made "tap the tab twice", the thing people
	 * actually do, mean two different things depending on where they started.
	 * From another page the pair was navigate-then-open and the list appeared;
	 * from the page you were already on it was open-then-close and nothing
	 * seemed to happen at all. Reported, accurately, as the tap working
	 * sometimes and not others.
	 *
	 * The pill beside it is still a toggle, and the scrim and Escape still
	 * dismiss — all three are on screen the moment the list is open, so nothing
	 * is lost by the bar only ever meaning "show me the list".
	 */
	open() {
		opener?.(true);
	}
};

export function registerPageList(fn: (open: boolean) => void): () => void {
	opener = fn;
	return () => {
		// Only clear if it is still ours. Svelte mounts the incoming page before
		// unmounting the outgoing one, so an unconditional clear on teardown
		// would wipe the registration the new page just made.
		if (opener === fn) opener = null;
	};
}
