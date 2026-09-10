import { describe, expect, it } from 'vitest';
import {
	createGestureTracker,
	createTapTracker,
	midpoint,
	pinchRotation,
	pinchScale,
	spread,
	wrapAngle
} from './gesture';

const at = (x: number, y: number) => ({ x, y });
/** A PointerEvent-shaped literal, which is all the tracker reads. */
const ev = (pointerId: number, x: number, y: number) => ({ pointerId, clientX: x, clientY: y });

describe('the pinch arithmetic', () => {
	it('measures how much wider the fingers got', () => {
		expect(pinchScale([at(100, 0), at(200, 0)], [at(50, 0), at(250, 0)])).toBe(2);
	});

	it('refuses to divide by two fingers on the same pixel', () => {
		// A zero spread is an infinite zoom with nothing to divide back by, and
		// the clamp downstream would leave the chart stuck at its ceiling.
		expect(pinchScale([at(100, 0), at(100, 0)], [at(50, 0), at(250, 0)])).toBe(1);
		expect(pinchScale([at(50, 0), at(250, 0)], [at(100, 0), at(100, 0)])).toBe(1);
	});

	it('measures a quarter turn, with a sign', () => {
		expect(pinchRotation([at(0, 0), at(100, 0)], [at(0, 0), at(0, 100)])).toBeCloseTo(Math.PI / 2);
		expect(pinchRotation([at(0, 0), at(0, 100)], [at(0, 0), at(100, 0)])).toBeCloseTo(-Math.PI / 2);
	});

	it('reads a hair past half a turn as a hair, not as a turn back', () => {
		// atan2 differences cross the seam at ±π. Unwrapped, a fingernail of
		// rotation there spins the chart most of the way round.
		expect(wrapAngle(3.1 + 0.08)).toBeCloseTo(-3.1 + 0.0016, 2);
		expect(Math.abs(wrapAngle(2 * Math.PI - 0.05))).toBeLessThan(0.06);
	});

	it('agrees with itself about middles and distances', () => {
		expect(midpoint(at(0, 0), at(10, 20))).toEqual(at(5, 10));
		expect(spread(at(0, 0), at(3, 4))).toBe(5);
	});
});

describe('createTapTracker', () => {
	it('sees a double when it is quick and close', () => {
		const taps = createTapTracker();
		expect(taps.tap(at(100, 100), 0)).toBe(false);
		expect(taps.tap(at(105, 103), 180)).toBe(true);
	});

	it('ignores one that is too slow', () => {
		const taps = createTapTracker();
		taps.tap(at(100, 100), 0);
		expect(taps.tap(at(100, 100), 900)).toBe(false);
	});

	it('ignores one that is too far away', () => {
		const taps = createTapTracker();
		taps.tap(at(100, 100), 0);
		expect(taps.tap(at(300, 100), 120)).toBe(false);
	});

	it('counts three quick taps as one double and one single', () => {
		// Keeping the second tap as the start of another would make a rested
		// thumb run the zoom away.
		const taps = createTapTracker();
		expect(taps.tap(at(10, 10), 0)).toBe(false);
		expect(taps.tap(at(10, 10), 100)).toBe(true);
		expect(taps.tap(at(10, 10), 200)).toBe(false);
	});
});

describe('createGestureTracker', () => {
	it('pans on one finger', () => {
		const g = createGestureTracker();
		g.down(ev(1, 100, 100));
		expect(g.kind).toBe('pan');
		expect(g.move(ev(1, 130, 110))).toEqual({ kind: 'pan', dx: 30, dy: 10 });
	});

	it('rotates instead when the caller says so', () => {
		const g = createGestureTracker({ rotate: (e) => e.shiftKey === true });
		g.down({ ...ev(1, 100, 100), shiftKey: true });
		expect(g.kind).toBe('rotate');
		expect(g.move(ev(1, 140, 100))).toEqual({ kind: 'rotate', dx: 40, dy: 0 });
	});

	it('becomes a pinch on the second finger', () => {
		const g = createGestureTracker();
		g.down(ev(1, 100, 200));
		g.down(ev(2, 200, 200));
		expect(g.kind).toBe('pinch');

		// Spread symmetrically: pure zoom, midpoint unmoved.
		const d = g.move(ev(1, 50, 200));
		expect(d?.kind).toBe('pinch');
		if (d?.kind !== 'pinch') throw new Error('expected a pinch');
		expect(d.scale).toBeCloseTo(1.5);
		expect(d.dx).toBeCloseTo(-25);
	});

	it('does not jump when one of two fingers lifts', () => {
		// The regression this file exists for. The map kept one lastX/lastY, so
		// after a lift the next move differenced the survivor against the pair's
		// midpoint and the chart leapt by half the gap between the fingers.
		const g = createGestureTracker();
		g.down(ev(1, 100, 200));
		g.down(ev(2, 300, 200));
		g.move(ev(1, 100, 200));

		g.up(ev(2, 300, 200));
		expect(g.kind).toBe('pan');

		// The survivor moves 10px, so the delta is 10px — not 110.
		expect(g.move(ev(1, 110, 200))).toEqual({ kind: 'pan', dx: 10, dy: 0 });
	});

	it('ignores a third finger rather than re-anchoring on it', () => {
		// A palm landing mid-pinch must not hand the chart to it.
		const g = createGestureTracker();
		g.down(ev(1, 100, 200));
		g.down(ev(2, 200, 200));
		g.down(ev(3, 900, 900));

		const d = g.move(ev(1, 50, 200));
		if (d?.kind !== 'pinch') throw new Error('expected a pinch');
		expect(d.scale).toBeCloseTo(1.5);
	});

	it('refuses a pointer that began somewhere else', () => {
		const g = createGestureTracker();
		g.down(ev(1, 100, 100));
		expect(g.move(ev(99, 500, 500))).toBeNull();
	});

	it('calls a still one-finger press a tap', () => {
		const g = createGestureTracker();
		g.down(ev(1, 100, 100));
		g.move(ev(1, 101, 100));
		expect(g.up(ev(1, 101, 100)).tapped).toBe(true);
	});

	it('never calls a two-finger gesture a tap, however still it was', () => {
		// Two fingers down means the chart, not the node underneath them.
		const g = createGestureTracker();
		g.down(ev(1, 100, 200));
		g.down(ev(2, 200, 200));
		g.up(ev(2, 200, 200));
		expect(g.up(ev(1, 100, 200)).tapped).toBe(false);
	});

	it('lets go of everything when the system takes the touch', () => {
		// There was no pointercancel handler at all, so an interrupted drag left
		// the mode stuck on and the next tap panned instead of selecting.
		const g = createGestureTracker();
		g.down(ev(1, 100, 100));
		g.down(ev(2, 200, 100));
		g.cancel();
		expect(g.kind).toBe('none');
		expect(g.count).toBe(0);
		expect(g.move(ev(1, 150, 100))).toBeNull();
	});

	it('starts clean after a cancelled gesture', () => {
		const g = createGestureTracker();
		g.down(ev(1, 100, 100));
		g.cancel();
		g.down(ev(1, 100, 100));
		expect(g.kind).toBe('pan');
		expect(g.up(ev(1, 100, 100)).tapped).toBe(true);
	});
});
