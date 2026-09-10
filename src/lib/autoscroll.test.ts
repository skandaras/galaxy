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

	const el = { scrollHeight, clientHeight, scrollTop, parentElement: null, scrollTo: vi.fn() };

	vi.stubGlobal('getComputedStyle', () => ({ overflowY: 'auto' }));
	vi.stubGlobal('document', { body: {}, scrollingElement: null, documentElement: {} });
	vi.stubGlobal('window', { ...bag(on), visualViewport: { ...bag(vvOn) }, scrollTo: vi.fn() });

	return {
		el: el as unknown as HTMLElement,
		counts: () => ({
			scroll: on.scroll?.length ?? 0,
			resize: on.resize?.length ?? 0,
			keyboard: vvOn.resize?.length ?? 0
		}),
		fire: (where: 'window' | 'viewport', type: string) => {
			for (const fn of (where === 'window' ? on : vvOn)[type] ?? []) fn();
		},
		move: (top: number) => {
			el.scrollTop = top;
		}
	};
}

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

		expect(env.counts()).toEqual({ scroll: 1, resize: 1, keyboard: 1 });

		env.move(200);
		env.fire('viewport', 'resize');
		expect(auto.pinned).toBe(false);
		detach();
	});

	it('lets go of every listener it took', () => {
		const env = fakeEnv();
		const auto = createAutoscroll();
		auto.attach(env.el)();
		expect(env.counts()).toEqual({ scroll: 0, resize: 0, keyboard: 0 });
	});

	it('survives a browser with no visualViewport', () => {
		const env = fakeEnv();
		(globalThis as { window: { visualViewport: unknown } }).window.visualViewport = undefined;
		const auto = createAutoscroll();
		const detach = auto.attach(env.el);
		expect(env.counts().keyboard).toBe(0);
		expect(() => detach()).not.toThrow();
	});
});
