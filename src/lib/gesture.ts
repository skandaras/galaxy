/**
 * Multi-touch bookkeeping and the arithmetic that goes with it.
 *
 * The lattice map tracked a drag with one shared lastX/lastY and no pointer id
 * at all, which works for exactly one finger. A second finger's pointerdown
 * overwrote that pair with its own coordinates, so the next move from the first
 * finger computed a delta of the distance between the two and the chart
 * teleported. Lifting either finger cleared the drag for both.
 *
 * Everything here is DOM-free so the maths can be tested as object literals —
 * which matters more than usual, because the failure mode of the code it
 * replaces was a jump nobody could reproduce on a desktop.
 */

export interface Pt {
	x: number;
	y: number;
}

/** The part of a PointerEvent this needs, so a test does not need a DOM. */
export interface PointerLike {
	pointerId: number;
	clientX: number;
	clientY: number;
}

export type GestureKind = 'none' | 'pan' | 'rotate' | 'pinch';

export type GestureDelta =
	| { kind: 'pan' | 'rotate'; dx: number; dy: number }
	| { kind: 'pinch'; scale: number; at: Pt; dx: number; dy: number; rotation: number }
	| null;

export const midpoint = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

export const spread = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Fold an angle into (-π, π].
 *
 * Differences of atan2 cross the ±π seam, where a hair of rotation past the
 * boundary reads as very nearly a full turn the other way.
 */
export function wrapAngle(radians: number): number {
	const turned = (((radians + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
	return turned - Math.PI;
}

export function pinchScale(from: readonly [Pt, Pt], to: readonly [Pt, Pt]): number {
	const before = spread(from[0], from[1]);
	const after = spread(to[0], to[1]);
	// Two fingers on the same pixel is a zero spread, and dividing by it is an
	// infinite zoom with nothing to divide back by.
	if (before <= 0 || after <= 0) return 1;
	return after / before;
}

export function pinchRotation(from: readonly [Pt, Pt], to: readonly [Pt, Pt]): number {
	const a = Math.atan2(from[1].y - from[0].y, from[1].x - from[0].x);
	const b = Math.atan2(to[1].y - to[0].y, to[1].x - to[0].x);
	return wrapAngle(b - a);
}

export interface TapWindow {
	ms: number;
	px: number;
}

export const DOUBLE_TAP: TapWindow = { ms: 300, px: 24 };

/**
 * Double-tap detection with no clock of its own: the caller passes the time, so
 * a test passes numbers instead of waiting.
 */
export function createTapTracker(win: TapWindow = DOUBLE_TAP) {
	let last: { at: Pt; t: number } | null = null;
	return {
		/** True when this tap completes a double. */
		tap(at: Pt, t: number): boolean {
			const isDouble =
				last !== null &&
				t - last.t <= win.ms &&
				Math.hypot(at.x - last.at.x, at.y - last.at.y) <= win.px;
			// A double consumes both taps rather than leaving the second to start
			// another. Three quick taps are one double and one single; kept, they
			// would be two doubles and the zoom would run away under a thumb that
			// simply rested.
			last = isDouble ? null : { at, t };
			return isDouble;
		},
		reset() {
			last = null;
		}
	};
}

export interface TrackerOptions {
	/** Travel before a press is a drag rather than a tap. Two, as the map used. */
	slop?: number;
	/** True when a single pointer should turn the view rather than move it. */
	rotate?: (e: { button?: number; shiftKey?: boolean }) => boolean;
}

export function createGestureTracker(opts: TrackerOptions = {}) {
	const slop = opts.slop ?? 2;
	const rotateWhen = opts.rotate ?? (() => false);

	const active = new Map<number, Pt>();
	let kind: GestureKind = 'none';
	let moved = false;
	let sawPinch = false;
	/** Where the pinch pair were last seen, so each move is an increment. */
	let prev: [Pt, Pt] | null = null;
	let lastSingle: Pt | null = null;

	/**
	 * The pinch is always the two lowest ids. A third finger — a palm, usually —
	 * joins the map but never becomes part of the gesture, so resting one down
	 * mid-pinch does not hand the chart to it.
	 */
	const readPair = (): [Pt, Pt] | null => {
		const ids = [...active.keys()].sort((a, b) => a - b);
		if (ids.length < 2) return null;
		return [{ ...active.get(ids[0])! }, { ...active.get(ids[1])! }];
	};

	const settleToSingle = () => {
		const [only] = [...active.values()];
		// The re-anchor that is the whole point of this file. Without it the next
		// move after lifting one finger differences the survivor's position
		// against the pair's midpoint, and the chart jumps by half the gap.
		lastSingle = { ...only };
		kind = 'pan';
		prev = null;
	};

	return {
		get kind() {
			return kind;
		},
		/** True once this gesture has travelled far enough not to be a tap. */
		get moved() {
			return moved;
		},
		get count() {
			return active.size;
		},

		down(e: PointerLike & { button?: number; shiftKey?: boolean }): GestureKind {
			active.set(e.pointerId, { x: e.clientX, y: e.clientY });
			if (active.size === 1) {
				moved = false;
				sawPinch = false;
				kind = rotateWhen(e) ? 'rotate' : 'pan';
				lastSingle = { x: e.clientX, y: e.clientY };
			} else if (active.size === 2) {
				kind = 'pinch';
				sawPinch = true;
				prev = readPair();
			}
			return kind;
		},

		move(e: PointerLike): GestureDelta {
			// A pointer that began somewhere else must not drive this. The map is
			// the record of what did begin here.
			if (!active.has(e.pointerId)) return null;
			const now = { x: e.clientX, y: e.clientY };
			active.set(e.pointerId, now);

			if (kind === 'pinch') {
				const next = readPair();
				if (!prev || !next) return null;
				const scale = pinchScale(prev, next);
				const rotation = pinchRotation(prev, next);
				const was = midpoint(prev[0], prev[1]);
				const is = midpoint(next[0], next[1]);
				prev = next;
				moved = true;
				return { kind: 'pinch', scale, at: is, dx: is.x - was.x, dy: is.y - was.y, rotation };
			}

			if (kind === 'none' || !lastSingle) return null;
			const dx = now.x - lastSingle.x;
			const dy = now.y - lastSingle.y;
			if (Math.abs(dx) > slop || Math.abs(dy) > slop) moved = true;
			lastSingle = now;
			return { kind, dx, dy };
		},

		up(e: PointerLike): { tapped: boolean; at: Pt } {
			const at = active.get(e.pointerId) ?? { x: e.clientX, y: e.clientY };
			active.delete(e.pointerId);

			if (active.size >= 2) {
				prev = readPair();
				return { tapped: false, at };
			}
			if (active.size === 1) {
				settleToSingle();
				return { tapped: false, at };
			}

			// A gesture that was ever a pinch is never a tap, however still the
			// fingers were: two fingers down means the chart, not a node.
			const tapped = !moved && !sawPinch;
			kind = 'none';
			prev = null;
			lastSingle = null;
			return { tapped, at };
		},

		/**
		 * A system gesture took the touch. Abandoning everything is right: what
		 * the browser hands back afterwards is not a continuation, and the map
		 * used to have no handler for this at all, so an interrupted drag left
		 * the mode stuck on and the next tap panned instead of selecting.
		 */
		cancel(): void {
			active.clear();
			kind = 'none';
			moved = false;
			sawPinch = false;
			prev = null;
			lastSingle = null;
		}
	};
}
