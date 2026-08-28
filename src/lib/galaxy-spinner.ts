/**
 * Geometry for the miniature galaxy that marks a turn in flight.
 *
 * The backdrop in `galaxy-art.ts` picks out its arms with
 * `cos(2θ − 5.4·ln r)`, which is brightest along `r = e^(2θ/5.4)` — a
 * logarithmic spiral. The same curve is drawn here as an SVG path, so the
 * spinner and the ambient backdrop are visibly the same galaxy rather than two
 * unrelated swirls.
 *
 * The ASCII art itself was tried at this size and does not survive the trip:
 * at 9×5 through 15×8 cells the quantisation destroys the spiral, the disc
 * collapses into one or two rows, and it needs a redraw every frame. A path
 * rotated by CSS costs nothing and stays crisp at 16px.
 */

/** Winding rate of the backdrop's arms, in radians of turn per unit of ln r. */
export const ARM_TIGHTNESS = 2 / 5.4;

export interface ArmOptions {
	/** Centre of the arm's rotation, in viewBox units. */
	cx?: number;
	cy?: number;
	/** Radius the arm reaches at its outer end. */
	radius?: number;
	/** Radians swept between the arm's inner and outer ends. */
	sweep?: number;
	/** Rotation of the whole arm about the core; π gives the opposite arm. */
	phase?: number;
	/** Samples along the curve. Enough that the polyline reads as smooth. */
	points?: number;
	/** How tightly the arm winds. Defaults to the backdrop's own constant. */
	tightness?: number;
}

/**
 * One arm as an SVG path, wound outwards from the core to `radius`.
 *
 * Coordinates are rounded, so the same options always produce byte-identical
 * output — a path that jittered between renders would be a diff for no reason.
 */
export function spiralArmPath(opts: ArmOptions = {}): string {
	const {
		cx = 12,
		cy = 12,
		radius = 10.5,
		sweep = 3.6,
		phase = 0,
		points = 28,
		tightness = ARM_TIGHTNESS
	} = opts;

	const steps = Math.max(2, Math.floor(points));
	const parts: string[] = [];
	for (let i = 0; i < steps; i++) {
		const t = i / (steps - 1);
		// θ runs from −sweep to 0 so that r reaches exactly `radius` at the end.
		const theta = (t - 1) * sweep;
		const r = radius * Math.exp(tightness * theta);
		const x = cx + r * Math.cos(theta + phase);
		const y = cy + r * Math.sin(theta + phase);
		parts.push(`${i === 0 ? 'M' : 'L'}${round(x)} ${round(y)}`);
	}
	return parts.join(' ');
}

function round(n: number): string {
	// Two decimals is finer than a 16px render can show, and keeps the path
	// short enough to sit inline in the component.
	return (Math.round(n * 100) / 100).toFixed(2);
}
