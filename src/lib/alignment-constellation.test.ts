import { describe, expect, it } from 'vitest';
import { constellationLines, hash01, layoutStars, type StarInput } from './alignment-constellation';

const star = (id: string, over: Partial<StarInput> = {}): StarInput => ({
	id,
	name: id,
	tradition: 'a tradition',
	recent: 3,
	direction: 'steady',
	weight: 3,
	count: 4,
	...over
});

describe('hash01', () => {
	it('is deterministic and stays inside the unit interval', () => {
		for (const id of ['authenticity', 'self-compassion', '', 'x']) {
			const value = hash01(id);
			expect(value).toBe(hash01(id));
			expect(value).toBeGreaterThanOrEqual(0);
			expect(value).toBeLessThan(1);
		}
	});

	it('separates ids that differ by one character', () => {
		expect(hash01('dimension-a')).not.toBe(hash01('dimension-b'));
	});
});

describe('layoutStars', () => {
	it('puts a star in the same place every time, whatever else changes', () => {
		const first = layoutStars([star('a'), star('b'), star('c')]);
		const second = layoutStars([
			star('a', { recent: 1, weight: 5, count: 99 }),
			star('b'),
			star('c')
		]);
		// Position is fixed by id and index alone: the sky keeps its shape and
		// only the light changes, which is what makes it readable week to week.
		expect(second[0].x).toBeCloseTo(first[0].x, 10);
		expect(second[0].y).toBeCloseTo(first[0].y, 10);
	});

	it('keeps every star inside the frame', () => {
		const stars = layoutStars(
			Array.from({ length: 12 }, (_, i) => star(`dimension-${i}`, { weight: 5, recent: 5 }))
		);
		for (const s of stars) {
			expect(s.x - s.r).toBeGreaterThan(0);
			expect(s.x + s.r).toBeLessThan(1);
			expect(s.y - s.r).toBeGreaterThan(0);
			expect(s.y + s.r).toBeLessThan(1);
		}
	});

	it('brightens with the recent reading', () => {
		const [dim, bright] = layoutStars([star('a', { recent: 1 }), star('b', { recent: 5 })]);
		expect(bright.brightness).toBeGreaterThan(dim.brightness);
		expect(bright.brightness).toBeLessThanOrEqual(1);
	});

	it('shows an unscored dimension as present but unlit', () => {
		const [s] = layoutStars([star('a', { recent: null, count: 0 })]);
		// "This has never come up" is information, so it must not vanish.
		expect(s.lit).toBe(false);
		expect(s.brightness).toBeGreaterThan(0);
	});

	it('spreads stars around rather than stacking them', () => {
		const stars = layoutStars(Array.from({ length: 8 }, (_, i) => star(`d-${i}`)));
		const angles = new Set(stars.map((s) => Math.round(Math.atan2(s.y - 0.5, s.x - 0.5) * 100)));
		expect(angles.size).toBe(8);
	});

	it('handles the empty and single cases without producing NaN', () => {
		expect(layoutStars([])).toEqual([]);
		const [only] = layoutStars([star('alone')]);
		expect(Number.isFinite(only.x)).toBe(true);
		expect(Number.isFinite(only.y)).toBe(true);
	});
});

describe('constellationLines', () => {
	it('closes the loop so it reads as a shape', () => {
		const stars = layoutStars([star('a'), star('b'), star('c')]);
		const lines = constellationLines(stars);
		expect(lines).toHaveLength(3);
		expect(lines[2].x2).toBeCloseTo(stars[0].x, 10);
	});

	it('draws nothing when there is nothing to join', () => {
		expect(constellationLines([])).toEqual([]);
		expect(constellationLines(layoutStars([star('a')]))).toEqual([]);
	});
});
