import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAutoscroll } from './autoscroll.svelte';

/**
 * A thread element and the window around it, with only what autoscroll reads.
 * jsdom would test the DOM more than the behaviour — the same reasoning
 * autoresize.test.ts records.
 */
function fakeEnv({ scrollHeight = 1000, clientHeight = 400, scrollTop = 0 } = {}) {
	const on: Record<string, Array<() => void>> = {};
	const vvOn: Record<string, Array<() => void>> = {};
	const bag = (b: Record<string, Array<() => void>>) => ({
		addEventListener: (t: string, fn: () => void) => void (b[t] ??= []).push(fn),
		removeEventListener: (t: string, fn: () => void) => {
			b[t] = (b[t] ?? []).filter((f) => f !== fn);
		}
	});

	// The thread's own listeners, for the capture-phase `load` that catches an
	// image finishing after the text around it.
	const elOn: Record<string, Array<() => void>> = {};
	const el = {
		scrollHeight,
		clientHeight,
		scrollTop,
		parentElement: null,
		scrollTo: vi.fn(),
		...bag(elOn)
	};

	// Mutations and frames are driven by hand: the point of every assertion
	// below is what autoscroll does when told the thread grew, not whether a
	// browser would have told it.
	let mutate: (() => void) | null = null;
	let observing = false;
	const frames: Array<() => void> = [];
	class FakeMutationObserver {
		constructor(fn: () => void) {
			mutate = fn;
		}
		observe() {
			observing = true;
		}
		disconnect() {
			observing = false;
			mutate = null;
		}
	}

	vi.stubGlobal('getComputedStyle', () => ({ overflowY: 'auto' }));
	vi.stubGlobal('document', { body: {}, scrollingElement: null, documentElement: {} });
	vi.stubGlobal('window', { ...bag(on), visualViewport: { ...bag(vvOn) }, scrollTo: vi.fn() });
	vi.stubGlobal('MutationObserver', FakeMutationObserver);
	vi.stubGlobal('requestAnimationFrame', (fn: () => void) => void frames.push(fn));

	return {
		el: el as unknown as HTMLElement,
		counts: () => ({
			scroll: on.scroll?.length ?? 0,
			resize: on.resize?.length ?? 0,
			keyboard: vvOn.resize?.length ?? 0,
			load: elOn.load?.length ?? 0
		}),
		observing: () => observing,
		/** The thread grew, and the frame that follows it ran. */
		grow: async () => {
			mutate?.();
			for (const fn of frames.splice(0)) fn();
			await settle();
		},
		/** A mutation with no frame yet — several of these are one burst. */
		mutate: () => mutate?.(),
		frame: async () => {
			for (const fn of frames.splice(0)) fn();
			await settle();
		},
		loaded: async () => {
			for (const fn of elOn.load ?? []) fn();
			for (const fn of frames.splice(0)) fn();
			await Promise.resolve();
		},
		fire: (where: 'window' | 'viewport', type: string) => {
			for (const fn of (where === 'window' ? on : vvOn)[type] ?? []) fn();
		},
		move: (top: number) => {
			el.scrollTop = top;
		}
	};
}

const settle = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => vi.unstubAllGlobals());

describe('createAutoscroll', () => {
	it('follows the bottom until someone scrolls away from it', () => {
		const env = fakeEnv();
		const auto = createAutoscroll();
		const detach = auto.attach(env.el);

		expect(auto.pinned).toBe(true);

		// 1000 - 200 - 400 = 400px from the bottom: reading back, not following.
		env.move(200);
		env.fire('window', 'scroll');
		expect(auto.pinned).toBe(false);

		// Back inside the 80px that still counts as following.
		env.move(560);
		env.fire('window', 'scroll');
		expect(auto.pinned).toBe(true);
		detach();
	});

	it('listens for the keyboard as well as the window', () => {
		// The keyboard genuinely changes how much thread is visible, and only
		// Android reports that as a window resize — on iOS the visual viewport
		// moves and the window hears nothing, so the thread would stay pinned to
		// a bottom that is now behind the keyboard.
		const env = fakeEnv();
		const auto = createAutoscroll();
		const detach = auto.attach(env.el);

		expect(env.counts()).toEqual({ scroll: 1, resize: 1, keyboard: 1, load: 1 });

		env.move(200);
		env.fire('viewport', 'resize');
		expect(auto.pinned).toBe(false);
		detach();
	});

	it('lets go of every listener it took', () => {
		const env = fakeEnv();
		const auto = createAutoscroll();
		auto.attach(env.el)();
		expect(env.counts()).toEqual({ scroll: 0, resize: 0, keyboard: 0, load: 0 });
	});

	it('survives a browser with no visualViewport', () => {
		const env = fakeEnv();
		(globalThis as { window: { visualViewport: unknown } }).window.visualViewport = undefined;
		const auto = createAutoscroll();
		const detach = auto.attach(env.el);
		expect(env.counts().keyboard).toBe(0);
		expect(() => detach()).not.toThrow();
	});

	describe('following what grows', () => {
		it('scrolls when the thread gains content, not only when the reply does', async () => {
			// The regression: chat followed streamText and the message count, so a
			// turn spent calling tools grew the timeline off the bottom and the
			// view sat still until the first token of prose.
			const env = fakeEnv();
			const auto = createAutoscroll();
			const detach = auto.attach(env.el);
			expect(env.observing()).toBe(true);

			await env.grow();
			expect(env.el.scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: 'auto' });
			detach();
		});

		it('leaves the view alone when the reader has scrolled up', async () => {
			const env = fakeEnv();
			const auto = createAutoscroll();
			const detach = auto.attach(env.el);

			env.move(200);
			env.fire('window', 'scroll');
			expect(auto.pinned).toBe(false);

			await env.grow();
			expect(env.el.scrollTo).not.toHaveBeenCalled();
			detach();
		});

		it('follows an image that finishes after the text around it', async () => {
			// A load changes the height without mutating anything, so the observer
			// above never hears about it.
			const env = fakeEnv();
			const auto = createAutoscroll();
			const detach = auto.attach(env.el);

			await env.loaded();
			expect(env.el.scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: 'auto' });
			detach();
		});

		it('costs one scroll a frame however many mutations arrive', async () => {
			// A streamed reply mutates the DOM per token and every follow reads
			// layout, so a burst inside one frame has to collapse to one scroll.
			const env = fakeEnv();
			const auto = createAutoscroll();
			const detach = auto.attach(env.el);

			env.mutate();
			env.mutate();
			env.mutate();
			await env.frame();
			expect(env.el.scrollTo).toHaveBeenCalledTimes(1);

			// ...and the next frame follows again rather than being swallowed.
			env.mutate();
			await env.frame();
			expect(env.el.scrollTo).toHaveBeenCalledTimes(2);
			detach();
		});

		it('stops watching once detached', () => {
			const env = fakeEnv();
			const auto = createAutoscroll();
			auto.attach(env.el)();
			expect(env.observing()).toBe(false);
		});
	});
});
