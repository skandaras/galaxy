import { describe, it, expect } from 'vitest';
import { orbDots, type OrbDot } from './galaxy-orb';

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
// Sampled off the dot's own latitude, which is its height taken back out to
// the surface — a dot deep inside the sphere sits low without being polar.
const latitude = (d: OrbDot) => Math.abs(d.y) / Math.hypot(d.y, d.ring);
const equator = (ds: OrbDot[]) => ds.filter((d) => latitude(d) < 0.3);
const polar = (ds: OrbDot[]) => ds.filter((d) => latitude(d) > 0.7);

describe('orbDots', () => {
	it('is deterministic for the same options', () => {
		expect(orbDots({ count: 30, turn: 0.7 })).toEqual(orbDots({ count: 30, turn: 0.7 }));
	});

	it('keeps every dot inside the sphere', () => {
		// The circle of latitude and the height off the equator are the two legs
		// of a right triangle on the dot's distance from the centre; if they
		// stop agreeing, the dots drift off the silhouette and the volume goes
		// with them.
		for (const d of orbDots({ count: 60 })) {
			expect(Math.hypot(d.y, d.ring)).toBeLessThanOrEqual(1);
			expect(Math.hypot(d.y, d.ring)).toBeGreaterThan(0.5);
		}
	});

	it('fills the sphere rather than tiling its surface', () => {
		// Every dot rode the surface at first, and a hollow shell projects
		// denser at its edge than through its middle — so the cluster drew as a
		// ring with a hole in it rather than as a body.
		const radii = orbDots({ count: 200 }).map((d) => Math.hypot(d.y, d.ring));
		const inner = radii.filter((r) => r < 0.8).length;
		expect(inner).toBeGreaterThan(radii.length * 0.25);
	});

	it('keeps every dot off the poles themselves', () => {
		// A dot at a pole has no circle to travel: it sits motionless while
		// everything around it moves, and reads as a stuck pixel.
		for (const d of orbDots({ count: 80 })) {
			expect(d.ring).toBeGreaterThan(0.1);
			expect(Math.abs(d.y)).toBeLessThan(1);
		}
	});

	it('turns the equator faster than the poles', () => {
		// This is the effect. Without a spread of rates the dots hold formation
		// and the sphere reads as a rendering of a globe rather than a swirl.
		const dots = orbDots({ count: 200 });
		expect(mean(equator(dots).map((d) => d.period))).toBeLessThan(
			mean(polar(dots).map((d) => d.period))
		);
	});

	it('shears harder when asked to', () => {
		const gap = (shear: number) => {
			const dots = orbDots({ count: 200, shear });
			return mean(polar(dots).map((d) => d.period)) - mean(equator(dots).map((d) => d.period));
		};
		expect(gap(0.3)).toBeGreaterThan(gap(0.7));
	});

	it('collapses to a rigid globe when the shear is flattened', () => {
		const dots = orbDots({ count: 200, shear: 1 });
		const gap = mean(polar(dots).map((d) => d.period)) - mean(equator(dots).map((d) => d.period));
		expect(Math.abs(gap)).toBeLessThan(0.06);
	});

	it('does not run a band of dots in lockstep', () => {
		// Latitude alone deciding the rate makes machined rings, not a swirl.
		const dots = orbDots({ count: 60 });
		const sorted = [...dots].sort((a, b) => Math.abs(a.y) - Math.abs(b.y));
		let closest = { gap: Infinity, same: false };
		for (let i = 1; i < sorted.length; i++) {
			const gap = Math.abs(Math.abs(sorted[i].y) - Math.abs(sorted[i - 1].y));
			if (gap < closest.gap) {
				closest = { gap, same: sorted[i].period === sorted[i - 1].period };
			}
		}
		expect(closest.same).toBe(false);
	});

	it('spreads the dots evenly instead of bunching them at the poles', () => {
		// Equal slices of a sphere's axis carry equal area, so an even lattice
		// puts a similar count in each. Drawing the latitude as an angle instead
		// crowds them into two bright caps joined by a sparse middle.
		const bands = [0, 0, 0, 0];
		for (const d of orbDots({ count: 400 })) {
			const lat = (d.y / Math.hypot(d.y, d.ring)) / 0.92;
			bands[Math.min(3, Math.floor(((lat + 1) / 2) * 4))]++;
		}
		for (const n of bands) expect(n).toBeGreaterThan(80);
	});

	it('scatters the starting longitudes across the whole revolution', () => {
		const quarters = [0, 0, 0, 0];
		for (const d of orbDots({ count: 200 })) quarters[Math.min(3, Math.floor(d.phase * 4))]++;
		for (const n of quarters) expect(n).toBeGreaterThan(35);
	});

	it('does not line the big dots up along a seam', () => {
		// Size and longitude came off the same sequence once, which correlated
		// them: every large dot landed on the same meridian, and the seam is
		// exactly the structure the sphere is trying not to have.
		const dots = orbDots({ count: 200 });
		const mp = mean(dots.map((d) => d.phase));
		const ms = mean(dots.map((d) => d.size));
		const cov = mean(dots.map((d) => (d.phase - mp) * (d.size - ms)));
		expect(Math.abs(cov)).toBeLessThan(0.002);
	});

	it('keeps every phase inside a single revolution', () => {
		// Consumed as a negative animation-delay: a value past 1 is valid CSS
		// and silently delays the dot by whole turns.
		for (const d of orbDots({ count: 80, turn: 3.7 })) {
			expect(d.phase).toBeGreaterThanOrEqual(0);
			expect(d.phase).toBeLessThan(1);
		}
	});

	it('turns the sphere without deforming it', () => {
		const plain = orbDots({ count: 24 });
		const turned = orbDots({ count: 24, turn: 0.25 });
		expect(turned.map((d) => d.y)).toEqual(plain.map((d) => d.y));
		expect(turned.map((d) => d.period)).toEqual(plain.map((d) => d.period));
		for (let i = 0; i < plain.length; i++) {
			expect((turned[i].phase - plain[i].phase + 1) % 1).toBeCloseTo(0.25, 3);
		}
	});

	it('keeps sizes and opacities inside what the orb can draw', () => {
		for (const d of orbDots({ count: 120 })) {
			expect(d.size).toBeGreaterThan(0);
			expect(d.size).toBeLessThan(0.25);
			expect(d.dim).toBeGreaterThan(0);
			expect(d.dim).toBeLessThanOrEqual(1);
		}
	});

	it('survives a count too small to form a sphere', () => {
		expect(orbDots({ count: 0 })).toEqual([]);
		expect(orbDots({ count: -5 })).toEqual([]);
		expect(orbDots({ count: 1 })).toHaveLength(1);
	});
});
