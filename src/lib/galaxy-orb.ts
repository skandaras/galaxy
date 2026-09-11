/**
 * Geometry for the dot sphere that marks what a turn is doing.
 *
 * `galaxy-spinner.ts` draws the galaxy as a shape — two arms and a core, one
 * rigid body turning. This draws a crowd. Every dot travels its own circle at
 * its own rate, and the sphere is what the crowd adds up to rather than
 * something any single dot belongs to.
 *
 * There are two patterns, and they are the difference between the two states:
 *
 * - `free`, for thinking: each dot on its own randomly tilted great circle. No
 *   two dots share an axis, so the cluster churns in every direction at once
 *   and reads as association rather than procedure.
 * - `axial`, for searching: only circles of latitude and meridians, alternating
 *   dot by dot. The orbits line up into something like an armillary sphere, and
 *   a sweep that regular reads as a search being *conducted*.
 *
 * An earlier version turned every dot on a circle of latitude about one shared
 * axis, with the rate set by how far from the equator it sat. That is a globe
 * spinning: correct, cohesive and far too orderly to be thinking. Both patterns
 * here keep the cohesion — see the note on `orbDots` — without the shared axis.
 *
 * Nothing is animated in JS. Each dot's orbit plane, rate and starting angle are
 * computed once and handed to CSS as custom properties, so an indicator that is
 * on screen for most of a run does not also keep a timer running for most of it.
 */

/**
 * Evenly spread, non-repeating values for the seven independent choices a dot
 * makes, from the R-sequence generalised to seven dimensions.
 *
 * `Math.random()` is wrong twice here: the sphere has to be byte-identical
 * between renders or it is a diff for no reason, and random points clump — at
 * thirty dots you reliably get a bald patch and a knot.
 *
 * Generated rather than hand-picked because the choices must not correlate with
 * each other. Hand-picked constants were fine at three and became a liability
 * past that: drawing size and brightness from one stream made every large dot
 * the bright one, which is the whole of what "more variety" was missing.
 */
function rSequence(dimensions: number): number[] {
	// The generalised plastic constant: the root of x^(d+1) = x + 1. Fixed-point
	// iteration converges on it in well under forty rounds for any d we use.
	let phi = 2;
	for (let i = 0; i < 40; i++) phi = Math.pow(1 + phi, 1 / (dimensions + 1));
	return Array.from({ length: dimensions }, (_, i) => 1 / Math.pow(phi, i + 1));
}

const [S_RADIUS, S_TILT, S_TURN, S_PHASE, S_SIZE, S_LUM, S_RATE] = rSequence(7);

/** Fractional part, which is what turns the sequence above into 0…1 streams. */
const frac = (n: number): number => n - Math.floor(n);

/** A unit vector, as the three numbers CSS needs rather than an object. */
type Vec = [number, number, number];

const cross = (a: Vec, b: Vec): Vec => [
	a[1] * b[2] - a[2] * b[1],
	a[2] * b[0] - a[0] * b[2],
	a[0] * b[1] - a[1] * b[0]
];

const unit = (v: Vec): Vec => {
	const n = Math.hypot(...v) || 1;
	return [v[0] / n, v[1] / n, v[2] / n];
};

export interface OrbDot {
	/**
	 * Height of this orbit's centre above the sphere's own, 0 for a circle that
	 * passes around the middle. Only a circle of latitude needs it — the axis it
	 * rings is vertical, so its centre rides up the axis.
	 */
	cy: number;
	/** Radius of the circle travelled, as a fraction of the orb's radius. */
	rad: number;
	/**
	 * Orthonormal basis of the orbit's plane: the dot sits at
	 * `centre + rad · (u·cos θ + v·sin θ)`. Two vectors rather than a normal
	 * because that is the form the keyframes consume directly — every component
	 * of the position is then one sinusoid, which is what lets a single shared
	 * `@keyframes` rule drive orbits of every orientation.
	 */
	ux: number;
	uy: number;
	uz: number;
	vx: number;
	vy: number;
	vz: number;
	/** Where on the circle the dot starts, as a fraction of one revolution. */
	phase: number;
	/** Time to travel it, relative to the slowest dot's. */
	period: number;
	/** Dot diameter, as a fraction of the orb's size. */
	size: number;
	/** Opacity at the sphere's midpoint, before depth brightens or dims it. */
	dim: number;
}

export type OrbPattern = 'free' | 'axial';

export interface OrbOptions {
	/** How many dots the sphere is made of. */
	count?: number;
	/** Which family of orbits to draw — see the note at the top of the file. */
	pattern?: OrbPattern;
	/** Shifts every dot along its circle, so two orbs are not in lockstep. */
	turn?: number;
}

/** Rounded, so identical options always produce byte-identical markup. */
const round = (n: number): number => Math.round(n * 1e4) / 1e4;

/**
 * The dots of one orb.
 *
 * What holds the sphere together under both patterns is that every orbit is
 * centred on the sphere's own centre or, for a circle of latitude, on a point
 * directly above it with the circle sized to match. Either way a dot's distance
 * from the middle is exactly its `depth` for the whole revolution — it can never
 * drift out of the silhouette or wander through the core, however its plane is
 * tilted. The dots are free; the ball they describe is not.
 *
 * Depths are spread as a range rather than pinned to the surface: a hollow shell
 * projects denser at its limb than through its middle, so every dot on the
 * surface drew as a ring with a hole in it rather than as a body.
 */
export function orbDots(opts: OrbOptions = {}): OrbDot[] {
	const { count = 30, pattern = 'free', turn = 0 } = opts;
	if (count < 1) return [];
	const dots: OrbDot[] = [];
	for (let i = 0; i < count; i++) {
		// Half-step offsets, so the first dot is not pinned to the centre of
		// every range at once.
		const at = (stream: number) => frac(0.5 + i * stream);
		const depth = 0.55 + 0.45 * at(S_RADIUS);

		let cy = 0;
		let rad = depth;
		let u: Vec;
		let v: Vec;

		if (pattern === 'axial') {
			// Alternating, so the two families come out even however many dots
			// there are, and — because the streams are evenly spread — interleave
			// through the sphere rather than clumping into two halves.
			if (i % 2 === 0) {
				// A circle of latitude. Held off the poles, where the circle
				// shrinks to a point and the dot would sit there motionless.
				cy = depth * (at(S_TILT) * 2 - 1) * 0.85;
				rad = Math.sqrt(Math.max(0, depth * depth - cy * cy));
				u = [1, 0, 0];
				v = [0, 0, 1];
			} else {
				// A meridian. Half a turn of longitude covers every distinct one:
				// the circle at φ and the circle at φ + π are the same ring.
				const lon = Math.PI * at(S_TURN);
				u = [Math.cos(lon), 0, Math.sin(lon)];
				v = [0, 1, 0];
			}
		} else {
			// A great circle of any orientation, from a normal drawn evenly over
			// the sphere of directions — uniform in height, which is Archimedes'
			// result and what keeps the tilts from bunching toward one axis.
			const nz = at(S_TILT) * 2 - 1;
			const ring = Math.sqrt(Math.max(0, 1 - nz * nz));
			const lon = 2 * Math.PI * at(S_TURN);
			const normal: Vec = [ring * Math.cos(lon), ring * Math.sin(lon), nz];
			// Any vector not parallel to the normal will do to get the first of
			// the two; swapped near the poles because the cross product of two
			// near-parallel vectors is noise.
			const helper: Vec = Math.abs(normal[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
			u = unit(cross(helper, normal));
			v = cross(normal, u);
		}

		// Inner orbits come round sooner, which is the one piece of the old
		// model worth keeping: it is what a galaxy does, and it stops the cluster
		// reading as a single object however the planes are tilted. `axial` holds
		// its rates far closer together — a search should look conducted, and
		// rings sweeping at wildly different speeds look like weather.
		const spread = pattern === 'axial' ? 0.16 : 0.44;
		const period = (0.45 + 0.55 * depth) * (1 - spread / 2 + spread * at(S_RATE));

		dots.push({
			cy: round(cy),
			rad: round(rad),
			ux: round(u[0]),
			uy: round(u[1]),
			uz: round(u[2]),
			vx: round(v[0]),
			vy: round(v[1]),
			vz: round(v[2]),
			phase: round(frac(at(S_PHASE) + turn)),
			period: round(period),
			// A tenth of the orb at the smallest: below that a dot stops reading
			// as part of a body and starts reading as dust, and the depth cue —
			// which works by growing it — has nothing to grow.
			size: round(0.085 + 0.115 * at(S_SIZE)),
			dim: round(0.4 + 0.38 * at(S_LUM))
		});
	}
	return dots;
}
