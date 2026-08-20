import { describe, expect, it } from 'vitest';
import { isFontAvailable, probeFonts, type Measure } from './font-probe';

/**
 * A stub browser: the named families have their own widths, and anything else
 * falls through to the generic — which is exactly what a real browser does with
 * a font that is not installed.
 */
function fakeBrowser(installed: Record<string, number>): Measure {
	const generics: Record<string, number> = {
		monospace: 100,
		'sans-serif': 110,
		serif: 120
	};
	return (_text, fontFamily) => {
		const generic = Object.keys(generics).find((g) => fontFamily.endsWith(g))!;
		const named = /"([^"]+)"/.exec(fontFamily)?.[1];
		if (named && named in installed) return installed[named];
		return generics[generic];
	};
}

describe('isFontAvailable', () => {
	it('reports a font that renders with its own metrics', () => {
		expect(isFontAvailable('Fira Code', fakeBrowser({ 'Fira Code': 95 }))).toBe(true);
	});

	it('reports a font that falls through to every generic', () => {
		expect(isFontAvailable('Fira Code', fakeBrowser({}))).toBe(false);
	});

	it('still finds a font that happens to match one generic exactly', () => {
		// Measured against only `monospace` this would read as missing. Checking
		// all three is what stops a metrically-identical face disappearing.
		expect(isFontAvailable('Twin', fakeBrowser({ Twin: 100 }))).toBe(true);
	});

	it('notices a difference of a fraction of a pixel', () => {
		// Falling through means the same font measured twice, so any real
		// difference is signal — a tolerance would hide narrow faces.
		expect(isFontAvailable('Hair', fakeBrowser({ Hair: 100.01 }))).toBe(true);
	});
});

describe('probeFonts', () => {
	const measure = fakeBrowser({ Consolas: 90 });

	it('checks only the fonts that name something to look for', () => {
		const result = probeFonts(
			[
				{ id: 'consolas', probe: 'Consolas' },
				{ id: 'fira-code', probe: 'Fira Code' },
				{ id: 'system-mono' }
			],
			measure
		);
		expect(result).toEqual({ consolas: true, 'fira-code': false, 'system-mono': true });
	});

	it('never marks a bundled font as missing', () => {
		// We ship the file, so there is nothing to detect and a false negative
		// would tell someone their default font is unavailable.
		const result = probeFonts([{ id: 'quicksand', probe: 'Quicksand', bundled: true }], measure);
		expect(result.quicksand).toBe(true);
	});

	it('says everything is available when there is no way to measure', () => {
		// Server-side render, or a browser that refuses a canvas context. Better
		// to say nothing than to label every font missing.
		const result = probeFonts([{ id: 'fira-code', probe: 'Fira Code' }], null);
		expect(result['fira-code']).toBe(true);
	});
});
