import { describe, it, expect } from 'vitest';
import { ARM_TIGHTNESS, spiralArmPath } from './galaxy-spinner';

/** Every coordinate pair in a path, in order. */
function points(path: string): Array<[number, number]> {
	return path
		.split(' ')
		.reduce<string[][]>((acc, tok, i) => {
			if (i % 2 === 0) acc.push([tok.replace(/^[ML]/, '')]);
			else acc[acc.length - 1].push(tok);
			return acc;
		}, [])
		.map(([x, y]) => [Number(x), Number(y)]);
}

const radius = (x: number, y: number, cx = 12, cy = 12) => Math.hypot(x - cx, y - cy);

describe('spiralArmPath', () => {
	it('is deterministic for the same options', () => {
		expect(spiralArmPath({ phase: 0.4 })).toBe(spiralArmPath({ phase: 0.4 }));
	});

	it('starts with a move and continues with lines', () => {
		const tokens = spiralArmPath().split(' ');
		expect(tokens[0].startsWith('M')).toBe(true);
		expect(tokens.slice(2).filter((t) => t.startsWith('M'))).toHaveLength(0);
	});

	it('winds outward from the core to the given radius', () => {
		const pts = points(spiralArmPath({ radius: 10.5, points: 20 }));
		const radii = pts.map(([x, y]) => radius(x, y));
		// Monotonic: an arm that doubled back would read as a scribble.
		for (let i = 1; i < radii.length; i++) expect(radii[i]).toBeGreaterThan(radii[i - 1]);
		expect(radii[0]).toBeLessThan(4);
		expect(radii.at(-1)).toBeCloseTo(10.5, 1);
	});

	it('stays inside the viewBox so nothing is clipped', () => {
		for (const [x, y] of points(spiralArmPath())) {
			expect(x).toBeGreaterThanOrEqual(0);
			expect(x).toBeLessThanOrEqual(24);
			expect(y).toBeGreaterThanOrEqual(0);
			expect(y).toBeLessThanOrEqual(24);
		}
	});

	it('puts the opposite arm half a turn away', () => {
		const a = points(spiralArmPath())[0];
		const b = points(spiralArmPath({ phase: Math.PI }))[0];
		// Same distance from the core, opposite side of it.
		expect(radius(...a)).toBeCloseTo(radius(...b), 6);
		expect(a[0] + b[0]).toBeCloseTo(24, 1);
		expect(a[1] + b[1]).toBeCloseTo(24, 1);
	});

	it('winds at the rate the ASCII backdrop draws its arms', () => {
		// galaxy-art picks out cos(2θ − 5.4·ln r); the two must not drift apart.
		expect(ARM_TIGHTNESS).toBeCloseTo(2 / 5.4, 12);
	});
});
