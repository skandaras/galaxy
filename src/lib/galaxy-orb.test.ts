import { describe, it, expect } from 'vitest';
import { orbDots, type OrbDot } from './galaxy-orb';

/** Where a dot is, a fraction `t` of the way round its orbit. */
const posAt = (d: OrbDot, t: number): [number, number, number] => {
	const a = 2 * Math.PI * t;
	const c = Math.cos(a);
	const s = Math.sin(a);
	return [
		d.rad * (d.ux * c + d.vx * s),
		d.cy + d.rad * (d.uy * c + d.vy * s),
		d.rad * (d.uz * c + d.vz * s)
	];
};

/** The axis the orbit rings, as the cross product of its two basis vectors. */
const normalOf = (d: OrbDot): [number, number, number] => [
	d.uy * d.vz - d.uz * d.vy,
	d.uz * d.vx - d.ux * d.vz,
	d.ux * d.vy - d.uy * d.vx
];

const TURNS = [0, 0.1, 0.25, 0.4, 0.5, 0.65, 0.75, 0.9];
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

describe('orbDots', () => {
	it('is deterministic for the same options', () => {
		expect(orbDots({ count: 30, turn: 0.7 })).toEqual(orbDots({ count: 30, turn: 0.7 }));
		expect(orbDots({ count: 30, pattern: 'axial' })).toEqual(
			orbDots({ count: 30, pattern: 'axial' })
		);
	});

	it('gives each orbit an orthonormal basis', () => {
		// The keyframes treat u and v as perpendicular unit vectors. If they stop
		// being either, the circle becomes an ellipse the depth cue then lies about.
		for (const pattern of ['free', 'axial'] as const) {
			for (const d of orbDots({ count: 60, pattern })) {
				expect(Math.hypot(d.ux, d.uy, d.uz)).toBeCloseTo(1, 3);
				expect(Math.hypot(d.vx, d.vy, d.vz)).toBeCloseTo(1, 3);
				expect(d.ux * d.vx + d.uy * d.vy + d.uz * d.vz).toBeCloseTo(0, 3);
			}
		}
	});

	it('holds every dot at a fixed distance from the centre, all the way round', () => {
		// This is what keeps a crowd of independently tilted orbits reading as one
		// sphere. A dot whose distance varied would bulge out of the silhouette at
		// one end of its circle and pass through the core at the other.
		for (const pattern of ['free', 'axial'] as const) {
			for (const d of orbDots({ count: 40, pattern })) {
				const radii = TURNS.map((t) => Math.hypot(...posAt(d, t)));
				for (const r of radii) expect(r).toBeCloseTo(radii[0], 3);
				expect(radii[0]).toBeGreaterThan(0.5);
				expect(radii[0]).toBeLessThanOrEqual(1);
			}
		}
	});

	it('fills the sphere rather than tiling its surface', () => {
		// A hollow shell projects denser at its limb than through its middle, so
		// every dot on the surface drew as a ring with a hole in it.
		const depths = orbDots({ count: 200 }).map((d) => Math.hypot(...posAt(d, 0)));
		expect(depths.filter((r) => r < 0.8).length).toBeGreaterThan(depths.length * 0.25);
	});

	it('never leaves a dot with no circle to travel', () => {
		for (const pattern of ['free', 'axial'] as const) {
			for (const d of orbDots({ count: 80, pattern })) {
				expect(d.rad).toBeGreaterThan(0.15);
			}
		}
	});

	describe('free', () => {
		it('tilts every orbit differently rather than sharing an axis', () => {
			// The shared-axis version of this was a globe spinning: cohesive, and
			// far too orderly to read as thinking.
			const normals = orbDots({ count: 60 }).map(normalOf);
			const spread = (axis: number) => {
				const vs = normals.map((n) => n[axis]);
				return Math.max(...vs) - Math.min(...vs);
			};
			for (const axis of [0, 1, 2]) expect(spread(axis)).toBeGreaterThan(1.4);
			// No two orbits sharing a plane, to a tolerance well inside rounding.
			const keys = new Set(normals.map((n) => n.map((c) => c.toFixed(2)).join(',')));
			expect(keys.size).toBe(normals.length);
		});

		it('rings the centre of the sphere itself', () => {
			for (const d of orbDots({ count: 40 })) expect(d.cy).toBe(0);
		});
	});

	describe('axial', () => {
		const family = (d: OrbDot) => {
			const ny = normalOf(d)[1];
			if (Math.abs(Math.abs(ny) - 1) < 1e-3) return 'latitude';
			if (Math.abs(ny) < 1e-3) return 'meridian';
			return 'tilted';
		};

		it('draws only circles of latitude and meridians', () => {
			for (const d of orbDots({ count: 80, pattern: 'axial' })) {
				expect(family(d)).not.toBe('tilted');
			}
		});

		it('splits the two families evenly', () => {
			const fams = orbDots({ count: 80, pattern: 'axial' }).map(family);
			expect(fams.filter((f) => f === 'latitude')).toHaveLength(40);
			expect(fams.filter((f) => f === 'meridian')).toHaveLength(40);
		});

		it('keeps an odd count even to within one dot', () => {
			const fams = orbDots({ count: 31, pattern: 'axial' }).map(family);
			const lat = fams.filter((f) => f === 'latitude').length;
			expect(Math.abs(lat - (fams.length - lat))).toBeLessThanOrEqual(1);
		});

		it('lifts its circles of latitude off the equator', () => {
			const lats = orbDots({ count: 80, pattern: 'axial' }).filter(
				(d) => family(d) === 'latitude'
			);
			expect(lats.some((d) => d.cy > 0.2)).toBe(true);
			expect(lats.some((d) => d.cy < -0.2)).toBe(true);
		});

		it('sweeps more regularly than free does', () => {
			// A search should look conducted. Rings running at wildly different
			// speeds look like weather.
			const range = (pattern: 'free' | 'axial') => {
				const ps = orbDots({ count: 120, pattern }).map((d) => d.period);
				return Math.max(...ps) - Math.min(...ps);
			};
			expect(range('axial')).toBeLessThan(range('free'));
		});
	});

	it('turns the inner orbits faster than the outer ones', () => {
		const dots = orbDots({ count: 200 });
		const depth = (d: OrbDot) => Math.hypot(...posAt(d, 0));
		const inner = dots.filter((d) => depth(d) < 0.7).map((d) => d.period);
		const outer = dots.filter((d) => depth(d) > 0.9).map((d) => d.period);
		expect(mean(inner)).toBeLessThan(mean(outer));
	});

	it('does not make the big dots the bright ones', () => {
		// Size and brightness came off one stream once, which tied them together
		// and is the whole of what "more variety" was missing.
		const dots = orbDots({ count: 200 });
		const ms = mean(dots.map((d) => d.size));
		const md = mean(dots.map((d) => d.dim));
		const cov = mean(dots.map((d) => (d.size - ms) * (d.dim - md)));
		expect(Math.abs(cov)).toBeLessThan(0.002);
	});

	it('scatters the starting angles across the whole revolution', () => {
		const quarters = [0, 0, 0, 0];
		for (const d of orbDots({ count: 200 })) quarters[Math.min(3, Math.floor(d.phase * 4))]++;
		for (const n of quarters) expect(n).toBeGreaterThan(35);
	});

	it('keeps every phase inside a single revolution', () => {
		// Consumed as a negative animation-delay: a value past 1 is valid CSS and
		// silently delays the dot by whole turns.
		for (const d of orbDots({ count: 80, turn: 3.7 })) {
			expect(d.phase).toBeGreaterThanOrEqual(0);
			expect(d.phase).toBeLessThan(1);
		}
	});

	it('shifts every dot along its orbit without deforming it', () => {
		const plain = orbDots({ count: 24 });
		const turned = orbDots({ count: 24, turn: 0.25 });
		expect(turned.map((d) => d.rad)).toEqual(plain.map((d) => d.rad));
		expect(turned.map((d) => d.ux)).toEqual(plain.map((d) => d.ux));
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
		expect(orbDots({ count: 1, pattern: 'axial' })).toHaveLength(1);
	});
});
