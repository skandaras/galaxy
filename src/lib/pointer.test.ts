import { afterEach, describe, expect, it, vi } from 'vitest';
import { hasFinePointer } from './pointer';

const withPointer = (query: string, matches: boolean) =>
	vi.stubGlobal('window', {
		matchMedia: (q: string) => ({ matches: q === query ? matches : !matches })
	});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('hasFinePointer', () => {
	it('is true for a mouse or trackpad', () => {
		withPointer('(pointer: fine)', true);
		expect(hasFinePointer()).toBe(true);
	});

	it('is false on a touch screen', () => {
		withPointer('(pointer: fine)', false);
		expect(hasFinePointer()).toBe(false);
	});

	it('assumes a keyboard when the browser cannot say', () => {
		// Failing open keeps Enter-to-send working on desktop, which is the
		// behaviour people have muscle memory for; the cost of being wrong the
		// other way is only that the send button is needed.
		vi.stubGlobal('window', {});
		expect(hasFinePointer()).toBe(true);
	});
});
