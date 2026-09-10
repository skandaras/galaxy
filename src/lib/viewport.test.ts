import { describe, expect, it, vi } from 'vitest';
import { attachViewport, keyboardInset, viewport, type ViewportTarget } from './viewport.svelte';

describe('keyboardInset', () => {
	it('reports nothing when the browser cannot say', () => {
		// Desktop Safari before 13, and every non-browser context. Reporting a
		// keyboard nobody can see would shrink the shell for no reason.
		expect(keyboardInset(null, 844)).toBe(0);
		expect(keyboardInset(undefined, 844)).toBe(0);
	});

	it('reports nothing when the viewport fills the window', () => {
		expect(keyboardInset({ height: 844, offsetTop: 0 }, 844)).toBe(0);
	});

	it('measures a keyboard that has taken half the screen', () => {
		expect(keyboardInset({ height: 480, offsetTop: 0 }, 844)).toBe(364);
	});

	it('counts the strip Safari has scrolled away', () => {
		// offsetTop is how far the visual viewport has been pushed down inside
		// the layout one. That strip is behind the keyboard too, so leaving it
		// out under-reports the inset by exactly the scroll — which on iOS is
		// most of it.
		expect(keyboardInset({ height: 480, offsetTop: 100 }, 844)).toBe(264);
	});

	it('ignores the URL bar settling', () => {
		// Chrome on Android collapses its address bar as you scroll, which moves
		// the viewport by about 56px. Treating that as a keyboard would jump the
		// composer every time someone scrolled a thread.
		expect(keyboardInset({ height: 814, offsetTop: 0 }, 844)).toBe(0);
	});

	it('ignores a viewport taller than the window', () => {
		// What pinching out looks like: the visual viewport grows past the layout
		// one and the subtraction goes negative.
		expect(keyboardInset({ height: 900, offsetTop: 0 }, 844)).toBe(0);
	});
});

/** A window with just the surface attachViewport touches. */
function fakeWindow(innerHeight = 844) {
	const listeners: Record<string, Array<() => void>> = {};
	const vvListeners: Record<string, Array<() => void>> = {};
	const listen = (bag: Record<string, Array<() => void>>) => ({
		addEventListener: (t: string, fn: () => void) => void (bag[t] ??= []).push(fn),
		removeEventListener: (t: string, fn: () => void) => {
			bag[t] = (bag[t] ?? []).filter((f) => f !== fn);
		}
	});
	const win = {
		innerHeight,
		visualViewport: { height: innerHeight, offsetTop: 0, ...listen(vvListeners) },
		scrollTo: vi.fn(),
		...listen(listeners)
	} satisfies ViewportTarget & { scrollTo: ReturnType<typeof vi.fn> };

	return {
		win,
		/** Move the visual viewport and fire the event iOS would fire. */
		resizeTo(height: number, offsetTop = 0) {
			win.visualViewport.height = height;
			win.visualViewport.offsetTop = offsetTop;
			for (const fn of vvListeners.resize ?? []) fn();
		},
		count: () =>
			(listeners.resize?.length ?? 0) +
			(vvListeners.resize?.length ?? 0) +
			(vvListeners.scroll?.length ?? 0)
	};
}

describe('attachViewport', () => {
	it('publishes the inset as a variable the CSS can read', () => {
		const setVar = vi.fn();
		const w = fakeWindow();
		const detach = attachViewport(w.win, setVar);

		w.resizeTo(480);
		expect(setVar).toHaveBeenCalledWith('--kbd', '364px');
		expect(viewport.keyboard).toBe(364);
		detach();
	});

	it('writes once per distinct value, not once per event', () => {
		// resize fires continuously while the keyboard animates in. The CSS only
		// cares about the number, so a repeat is a wasted style recalculation on
		// the frame budget of the animation itself.
		const setVar = vi.fn();
		const w = fakeWindow();
		const detach = attachViewport(w.win, setVar);

		w.resizeTo(480);
		w.resizeTo(480);
		w.resizeTo(480);
		expect(setVar).toHaveBeenCalledTimes(1);
		detach();
	});

	it('puts Safari’s scroll back exactly once, on the way open', () => {
		// iOS scrolls the page to lift a focused field above the keyboard even
		// when the shell cannot scroll, which drags the fixed chrome off-screen.
		// Undoing it on every event instead is a scroll fight Safari wins.
		const w = fakeWindow();
		const detach = attachViewport(w.win, vi.fn());

		w.resizeTo(480);
		w.resizeTo(470);
		w.resizeTo(460);
		expect(w.win.scrollTo).toHaveBeenCalledTimes(1);
		expect(w.win.scrollTo).toHaveBeenCalledWith(0, 0);
		detach();
	});

	it('does not scroll when no keyboard ever opens', () => {
		const w = fakeWindow();
		const detach = attachViewport(w.win, vi.fn());

		w.resizeTo(814); // the URL bar, under the floor
		expect(w.win.scrollTo).not.toHaveBeenCalled();
		detach();
	});

	it('scrolls again on the next open after a close', () => {
		const w = fakeWindow();
		const detach = attachViewport(w.win, vi.fn());

		w.resizeTo(480);
		w.resizeTo(844); // dismissed
		w.resizeTo(480); // and opened again
		expect(w.win.scrollTo).toHaveBeenCalledTimes(2);
		detach();
	});

	it('lets go of every listener it took', () => {
		const w = fakeWindow();
		const detach = attachViewport(w.win, vi.fn());
		expect(w.count()).toBe(3);
		detach();
		expect(w.count()).toBe(0);
	});

	it('reports nothing once detached, so the next mount starts clean', () => {
		const w = fakeWindow();
		const detach = attachViewport(w.win, vi.fn());
		w.resizeTo(480);
		expect(viewport.keyboard).toBe(364);
		detach();
		expect(viewport.keyboard).toBe(0);
	});

	it('survives a browser with no visualViewport at all', () => {
		const setVar = vi.fn();
		const listeners: Record<string, Array<() => void>> = {};
		const win: ViewportTarget = {
			innerHeight: 900,
			visualViewport: null,
			scrollTo: vi.fn(),
			addEventListener: (t, fn) => void (listeners[t] ??= []).push(fn),
			removeEventListener: (t, fn) => {
				listeners[t] = (listeners[t] ?? []).filter((f) => f !== fn);
			}
		};

		const detach = attachViewport(win, setVar);
		for (const fn of listeners.resize ?? []) fn();
		expect(viewport.keyboard).toBe(0);
		expect(setVar).not.toHaveBeenCalled();
		detach();
		expect(listeners.resize).toEqual([]);
	});
});
