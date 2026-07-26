import { describe, it, expect } from 'vitest';
import { BACKDROP_COLS, BACKDROP_ROWS, generateGalaxy } from './galaxy-art';

const COLS = BACKDROP_COLS;
const ROWS = BACKDROP_ROWS;

function diffRatio(a: string, b: string): number {
	let n = 0;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
	return n / a.length;
}

describe('generateGalaxy', () => {
	it('is deterministic for the same inputs', () => {
		expect(generateGalaxy(COLS, ROWS, { rotation: 0.15 })).toBe(
			generateGalaxy(COLS, ROWS, { rotation: 0.15 })
		);
	});

	it('emits a fixed-width block so the centred backdrop cannot jitter', () => {
		const lines = generateGalaxy(COLS, ROWS).split('\n');
		expect(lines).toHaveLength(ROWS);
		expect(new Set(lines.map((l) => l.length))).toEqual(new Set([COLS]));
	});

	it('has a dense core and sparse edges', () => {
		const lines = generateGalaxy(COLS, ROWS).split('\n');
		const mid = lines[Math.floor(ROWS / 2)];
		const core = mid.slice(COLS / 2 - 6, COLS / 2 + 6);
		expect(core.trim().length).toBeGreaterThan(6);
		expect(lines[0].trim().length).toBeLessThan(COLS / 3);
	});

	it('rotates smoothly: one animation frame nudges few cells, not the whole field', () => {
		const base = generateGalaxy(COLS, ROWS, { rotation: 0 });
		// ~one frame at 240s/revolution and a 200ms cadence.
		const nextFrame = generateGalaxy(COLS, ROWS, { rotation: (Math.PI * 2 * 0.2) / 240 });
		const drift = diffRatio(base, nextFrame);
		// Non-zero (it is animating) but nowhere near a full redraw (no boiling).
		expect(drift).toBeGreaterThan(0);
		expect(drift).toBeLessThan(0.05);
	});

	it('shows clear movement over a larger rotation', () => {
		const base = generateGalaxy(COLS, ROWS, { rotation: 0 });
		expect(diffRatio(base, generateGalaxy(COLS, ROWS, { rotation: 0.4 }))).toBeGreaterThan(0.02);
	});

	it('is periodic over a full revolution', () => {
		expect(generateGalaxy(COLS, ROWS, { rotation: Math.PI * 2 })).toBe(
			generateGalaxy(COLS, ROWS, { rotation: 0 })
		);
	});
});
