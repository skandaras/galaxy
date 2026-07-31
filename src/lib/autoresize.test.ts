import { afterEach, describe, expect, it, vi } from 'vitest';
import { autoresize } from './autoresize';

/**
 * A textarea stand-in. The suite runs in node with no DOM, and pulling in jsdom
 * to assert arithmetic would test the DOM more than the action — what matters
 * here is that the height it computes accounts for the box model and respects
 * the cap, which is exactly what a fake element can show.
 */
function fakeTextarea(opts: {
	contentHeight: number;
	boxSizing?: string;
	maxHeight?: string;
	padding?: number;
	border?: number;
}) {
	const padding = opts.padding ?? 10;
	const border = opts.border ?? 1;
	const listeners = new Map<string, Set<() => void>>();

	const node = {
		style: { height: '' },
		// scrollHeight is content + padding, and is only meaningful once height
		// has been collapsed to 'auto' — which is what the action does first.
		get scrollHeight() {
			return opts.contentHeight + padding * 2;
		},
		addEventListener(type: string, fn: () => void) {
			(listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(fn);
		},
		removeEventListener(type: string, fn: () => void) {
			listeners.get(type)?.delete(fn);
		},
		fire(type: string) {
			for (const fn of listeners.get(type) ?? []) fn();
		},
		listenerCount: (type: string) => listeners.get(type)?.size ?? 0
	};

	vi.stubGlobal('getComputedStyle', () => ({
		boxSizing: opts.boxSizing ?? 'border-box',
		maxHeight: opts.maxHeight ?? 'none',
		paddingTop: `${padding}px`,
		paddingBottom: `${padding}px`,
		borderTopWidth: `${border}px`,
		borderBottomWidth: `${border}px`
	}));

	return node as unknown as HTMLTextAreaElement & {
		fire(type: string): void;
		listenerCount(type: string): number;
	};
}

const windowStub = () => {
	const listeners = new Set<() => void>();
	vi.stubGlobal('window', {
		addEventListener: (_t: string, fn: () => void) => listeners.add(fn),
		removeEventListener: (_t: string, fn: () => void) => listeners.delete(fn)
	});
	return listeners;
};

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('autoresize', () => {
	it('sizes to the content, adding the border under border-box sizing', () => {
		windowStub();
		const node = fakeTextarea({ contentHeight: 60, padding: 10, border: 1 });
		autoresize(node, '');
		// 60 content + 20 padding + 2 border
		expect(node.style.height).toBe('82px');
	});

	it('subtracts padding instead under content-box sizing', () => {
		windowStub();
		const node = fakeTextarea({ contentHeight: 60, padding: 10, boxSizing: 'content-box' });
		autoresize(node, '');
		// `height` means the content box here, so the padding scrollHeight
		// includes has to come back off — otherwise the box creeps taller on
		// every measurement.
		expect(node.style.height).toBe('60px');
	});

	it('stops at the cap the CSS sets, so a long paste scrolls instead', () => {
		windowStub();
		const node = fakeTextarea({ contentHeight: 900, maxHeight: '192px' });
		autoresize(node, '');
		expect(node.style.height).toBe('192px');
	});

	it('re-measures when the value changes without an input event', () => {
		windowStub();
		let content = 40;
		const node = fakeTextarea({ contentHeight: 40, padding: 0, border: 0 });
		Object.defineProperty(node, 'scrollHeight', { get: () => content });

		const handle = autoresize(node, 'short');
		expect(node.style.height).toBe('40px');

		// Sending clears the composer programmatically: no input event fires, so
		// only the value-driven update can shrink the box back.
		content = 20;
		handle.update('');
		expect(node.style.height).toBe('20px');
	});

	it('does no work when the value is unchanged', () => {
		windowStub();
		const node = fakeTextarea({ contentHeight: 40, padding: 0, border: 0 });
		const handle = autoresize(node, 'same');
		node.style.height = 'sentinel';
		handle.update('same');
		expect(node.style.height).toBe('sentinel');
	});

	it('grows on input and cleans up its listeners on destroy', () => {
		const windowListeners = windowStub();
		const node = fakeTextarea({ contentHeight: 40, padding: 0, border: 0 });
		const handle = autoresize(node, '');

		expect(node.listenerCount('input')).toBe(1);
		expect(windowListeners.size).toBe(1);

		node.style.height = 'sentinel';
		node.fire('input');
		expect(node.style.height).toBe('40px');

		handle.destroy();
		expect(node.listenerCount('input')).toBe(0);
		expect(windowListeners.size).toBe(0);
	});
});
