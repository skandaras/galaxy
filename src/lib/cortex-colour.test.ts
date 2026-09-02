import { describe, it, expect } from 'vitest';
import { areaColourCss, areaHueHex, areaShade, hslToHex } from './cortex-colour';

describe('areaShade', () => {
	it('is deterministic, and stays inside the bands', () => {
		for (const id of ['coastal-fieldwork', 'letterpress', 'x', 'a-very-long-area-id-2']) {
			const shade = areaShade(id);
			expect(shade).toEqual(areaShade(id));
			expect(shade.h).toBeGreaterThanOrEqual(0);
			expect(shade.h).toBeLessThan(360);
			// Narrow on purpose: 52/62 was fixed so a hue stays legible on both a
			// near-black and a cream page, and these bands sit around it.
			expect(shade.s).toBeGreaterThanOrEqual(46);
			expect(shade.s).toBeLessThanOrEqual(60);
			expect(shade.l).toBeGreaterThanOrEqual(55);
			expect(shade.l).toBeLessThanOrEqual(68);
		}
	});

	it('separates ids that differ by one character', () => {
		expect(areaShade('area-a').h).not.toBe(areaShade('area-b').h);
	});

	it('varies shade as well as hue, so a hue collision is still two colours', () => {
		const ids = ['coastal-fieldwork', 'letterpress', 'tax', 'house-move', 'reading'];
		expect(new Set(ids.map((id) => areaShade(id).s)).size).toBeGreaterThan(1);
		expect(new Set(ids.map((id) => areaShade(id).l)).size).toBeGreaterThan(1);
	});
});

describe('an area keeps its colour', () => {
	it('when unrelated areas appear', () => {
		// The whole reason this is hashed. Under the previous rule a hue was the
		// id's slot in the sorted set of ids on nodes, so filing something under
		// an area sorting before this one moved this one's colour — and any
		// colour somebody had chosen the rest of the map to sit against with it.
		const before = areaColourCss('letterpress');
		for (const added of ['aardvark', 'admin', 'bookbinding', 'zoology']) {
			expect(areaColourCss('letterpress'), `after adding ${added}`).toBe(before);
		}
	});

	it('when it is renamed, because the hash is over the id', () => {
		// Renaming writes `name` and never `id` (see saveCircuit), so there is
		// nothing here to recompute — this test pins the property that makes that
		// true rather than the mechanism.
		expect(areaColourCss('coastal-fieldwork')).toBe(areaColourCss('coastal-fieldwork'));
	});
});

describe('the two output formats agree', () => {
	it('describes one colour, not two that look similar', () => {
		// The chart draws `hsl()` and the colour input takes `#rrggbb`, and an
		// area with no colour set has to open its picker on the colour it is
		// actually drawn in. This is the check holding those in step.
		for (const id of ['coastal-fieldwork', 'letterpress', 'tax']) {
			const { h, s, l } = areaShade(id);
			expect(areaColourCss(id)).toBe(`hsl(${h.toFixed(1)} ${s.toFixed(1)}% ${l.toFixed(1)}%)`);
			expect(areaHueHex(id)).toBe(hslToHex(h, s, l));
		}
	});

	it('always gives the colour input a six-digit hex, which is all it accepts', () => {
		for (const id of ['a', 'coastal-fieldwork', '', 'x-2']) {
			expect(areaHueHex(id)).toMatch(/^#[0-9a-f]{6}$/);
		}
	});
});

describe('hslToHex', () => {
	it('converts the anchor shade the fixed pair used to be', () => {
		// hsl(0 52% 62%): lightness is (0xd0 + 0x6c) / 2 / 255 = 0.62, and with
		// green and blue equal the hue is 0 — checkable by hand from the result.
		expect(hslToHex(0, 52, 62)).toBe('#d06c6c');
	});

	it('handles the greys and the wheel’s wrap', () => {
		expect(hslToHex(0, 0, 0)).toBe('#000000');
		expect(hslToHex(0, 0, 100)).toBe('#ffffff');
		expect(hslToHex(360, 52, 62)).toBe(hslToHex(0, 52, 62));
	});
});
