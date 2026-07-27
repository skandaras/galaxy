import { tick } from 'svelte';

/** How close to the bottom still counts as "following the conversation". */
const NEAR_BOTTOM_PX = 80;
/** Ignore scroll events we caused ourselves for this long (smooth scrolling). */
const PROGRAMMATIC_MS = 700;

function isScrollable(el: Element): boolean {
	const overflowY = getComputedStyle(el).overflowY;
	return (
		(overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') &&
		el.scrollHeight > el.clientHeight + 1
	);
}

/**
 * Find whatever is actually scrolling. On desktop that's the thread element
 * itself; below 720px the layout drops `overflow: hidden` from the shell
 * (see +layout.svelte) so the page scrolls instead and the thread element
 * never moves. Resolved per call because a short thread isn't scrollable yet.
 */
function resolveScroller(from: HTMLElement): HTMLElement {
	let node: HTMLElement | null = from;
	while (node && node !== document.body) {
		if (isScrollable(node)) return node;
		node = node.parentElement;
	}
	return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}

export interface Autoscroll {
	/** True while the view is following the bottom of the conversation. */
	readonly pinned: boolean;
	/** Svelte action-ish attach; returns a teardown for $effect. */
	attach: (node: HTMLElement) => () => void;
	/** Jump to the newest content and resume following. */
	toBottom: (behavior?: ScrollBehavior) => Promise<void>;
	/** Keep the newest content in view, but only if the user hasn't scrolled up. */
	follow: () => Promise<void>;
}

export function createAutoscroll(): Autoscroll {
	let el: HTMLElement | null = null;
	let pinned = $state(true);
	let ignoreUntil = 0;

	function scroller(): HTMLElement | null {
		return el ? resolveScroller(el) : null;
	}

	function onScroll(): void {
		if (!el || Date.now() < ignoreUntil) return;
		const s = scroller();
		if (!s) return;
		pinned = s.scrollHeight - s.scrollTop - s.clientHeight <= NEAR_BOTTOM_PX;
	}

	async function toBottom(behavior: ScrollBehavior = 'auto'): Promise<void> {
		await tick();
		const s = scroller();
		if (!s) return;
		if (behavior === 'smooth') ignoreUntil = Date.now() + PROGRAMMATIC_MS;
		const top = s.scrollHeight;
		// scrollingElement has to be driven through the window, not itself.
		if (s === document.scrollingElement || s === document.documentElement) {
			window.scrollTo({ top, behavior });
		} else {
			s.scrollTo({ top, behavior });
		}
		pinned = true;
	}

	return {
		get pinned() {
			return pinned;
		},
		attach(node: HTMLElement) {
			el = node;
			// Scroll events don't bubble, but they do capture — one listener on
			// the window catches both the thread element and the page.
			window.addEventListener('scroll', onScroll, true);
			window.addEventListener('resize', onScroll);
			return () => {
				window.removeEventListener('scroll', onScroll, true);
				window.removeEventListener('resize', onScroll);
				el = null;
			};
		},
		toBottom,
		async follow() {
			if (pinned) await toBottom('auto');
		}
	};
}
