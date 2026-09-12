/**
 * How much of the viewport the software keyboard is covering.
 *
 * The two platforms disagree about what opening a keyboard even is. Android
 * resizes the layout viewport, so `window.resize` fires and anything laid out
 * against it simply reflows. iOS Safari does neither: the layout viewport is
 * untouched, `visualViewport` fires instead, and Safari scrolls the layout
 * viewport up behind the keyboard — dragging any position:fixed bottom chrome
 * off the screen with it. So the inset has to be measured rather than inferred,
 * and on iOS the scroll has to be put back.
 *
 * Nothing in the tree listened to `visualViewport` before this. `autoresize.ts`
 * and `autoscroll.svelte.ts` both listen to `window.resize`, which is the
 * Android half only.
 */

/** Below this, a change is the URL bar settling rather than a keyboard. */
export const KEYBOARD_MIN = 60;

export interface VisualViewportLike {
	height: number;
	offsetTop: number;
}

interface Listenable {
	addEventListener(type: string, fn: () => void): void;
	removeEventListener(type: string, fn: () => void): void;
}

export interface ViewportTarget extends Listenable {
	innerHeight: number;
	visualViewport?: (VisualViewportLike & Listenable) | null;
	scrollTo(x: number, y: number): void;
}

/**
 * Pure, because everything that matters here is two numbers. Split out from the
 * listeners so the arithmetic can be tested with object literals rather than by
 * pulling in a DOM.
 */
export function keyboardInset(
	vv: VisualViewportLike | null | undefined,
	innerHeight: number
): number {
	if (!vv) return 0;
	// offsetTop counts. It is how far Safari has scrolled the visual viewport
	// down inside the layout one, and that strip is behind the keyboard too —
	// leaving it out under-reports the inset by exactly the scroll.
	const covered = innerHeight - vv.height - vv.offsetTop;
	// Negative means the visual viewport is taller than the layout one, which is
	// what pinching out looks like. Not a keyboard.
	return covered > KEYBOARD_MIN ? Math.round(covered) : 0;
}

let kbd = $state(0);

export const viewport = {
	/** Pixels of viewport the software keyboard is currently covering. */
	get keyboard() {
		return kbd;
	}
};

/**
 * Never read `kbd` from inside here.
 *
 * attachViewport is called from an $effect in the root layout, and it calls
 * read() synchronously during setup. The de-duplication below used to compare
 * against `kbd` itself, which made that $effect a *reader* of a signal the same
 * call then wrote — so the first inset big enough to publish re-dirtied the
 * effect, whose teardown reset `kbd` to 0, whose body re-read a still-non-zero
 * inset, and round again until Svelte gave up with effect_update_depth_exceeded
 * about a thousand iterations later. With no <svelte:boundary> in the tree that
 * throw escapes into a microtask, and every effect still queued behind it in
 * that batch is dropped: the page keeps its last painted frame, scrolls, takes
 * focus rings and accepts typed characters, and responds to nothing. The
 * keyboard inset settles back to 0 on the way out, so it does not even leave a
 * mark on the layout to find it by.
 *
 * It needed the layout viewport and the visual viewport to disagree by more
 * than KEYBOARD_MIN for one event, which is what resuming an installed app
 * produces — reported as the whole interface dying after switching away and
 * coming back.
 *
 * So the comparison is a plain local. `kbd` is only ever written here, never
 * read, and the signal is an output rather than part of the arithmetic.
 */

/**
 * Publishes the inset as `--kbd` and returns a teardown, taking its window
 * injected so a test can drive it with a plain object — the same shape
 * `createResizablePane` uses for storage.
 */
export function attachViewport(
	win: ViewportTarget,
	setVar: (name: string, value: string) => void
): () => void {
	const vv = win.visualViewport ?? null;

	// -1 rather than 0 so a mount with no keyboard still publishes once. --kbd
	// used to get an inline value only after an inset had been seen, which left
	// the stylesheet default as the only thing standing between the layout and a
	// stale reading from a previous attach.
	let published = -1;

	const publish = (next: number) => {
		// resize fires continuously while the keyboard animates in, and the CSS
		// only cares about the number — so de-duplicate on the value rather than
		// sniffing the platform. That is also what lets both listeners coexist:
		// Android moves the layout viewport, iOS moves the visual one, and
		// neither fires the other's event.
		if (next === published) return;
		const wasShut = published <= 0;
		published = next;
		kbd = next;
		setVar('--kbd', `${next}px`);
		// iOS lifts a focused field above the keyboard by scrolling the page,
		// even when the shell is 100dvh and overflow:hidden — which takes the
		// fixed chrome with it. Undone once, on the way open. Doing it on every
		// event is a scroll fight with Safari that Safari wins.
		if (wasShut && next > 0) win.scrollTo(0, 0);
	};

	const read = () => publish(keyboardInset(vv, win.innerHeight));

	vv?.addEventListener('resize', read);
	vv?.addEventListener('scroll', read);
	win.addEventListener('resize', read);
	read();

	return () => {
		vv?.removeEventListener('resize', read);
		vv?.removeEventListener('scroll', read);
		win.removeEventListener('resize', read);
		// Nothing is watching any more, so nothing is covered. This used to
		// assign `kbd = 0` directly, which zeroed the signal and left --kbd on
		// the document at whatever it last said — and the de-duplication above
		// then compared against the zeroed signal and never corrected it. Going
		// through publish() writes both, so the two cannot drift apart.
		publish(0);
	};
}
