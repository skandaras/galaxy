/**
 * Geometry for the dot sphere that marks what a turn is doing.
 *
 * `galaxy-spinner.ts` draws the galaxy as a shape — two arms and a core, one
 * rigid body turning. This draws a body: a sphere stippled with dots, turning
 * about its vertical axis. What keeps it from looking like a wireframe globe is
 * that the dots do not hold formation. Each one travels its own circle of
 * latitude at its own rate, fastest at the equator and slowest toward the
 * poles, so bands shear past each other continuously. Stars do this; so does
 * the Sun. It is the difference between an object rotating and an object alive.
 *
 * Two earlier attempts are worth not repeating. Turning every dot at one rate
 * is a rigid globe, and reads as a rendering of a sphere rather than a swirl.
 * Scattering the dots over a flat disc instead loses the volume entirely, and
 * — when the radius was stepped by the loop counter while the angle advanced
 * by very nearly a quarter turn each step — resolved into four bent spokes,
 * because every fourth dot landed on the same bearing a little further out.
 *
 * Nothing here is animated in JS. Each dot's circle, rate and starting angle
 * are computed once and handed to CSS as custom properties, so an indicator
 * that is on screen for most of a run does not also keep a timer running for
 * most of a run.
 */

/**
 * Low-discrepancy constants, used to place the dots.
 *
 * `Math.random()` was the obvious thing and is wrong twice: the sphere has to
 * be byte-identical between renders or it is a diff for no reason, and random
 * points clump — at thirty dots you reliably get a bald patch and a knot.
 *
 * Three separate streams, because latitude, longitude and size all being drawn
 * from one sequence correlates them: the big dots line up along a seam, and
 * the seam is exactly the structure the sphere is trying not to have.
 */
const STREAM_LAT = 0.7548776662;
const STREAM_LON = 0.5698402909;
const STREAM_JITTER = 0.8191725134;
const STREAM_DEPTH = 0.430159709;

/** Fractional part, which is what turns the constants above into 0…1 streams. */
const frac = (n: number): number => n - Math.floor(n);

export interface OrbDot {
	/** Latitude as a height, −1 at the south pole to 1 at the north. */
	y: number;
	/**
	 * Radius of the circle of latitude this dot travels, scaled by how far out
	 * from the centre the dot sits. Also exactly how far it swings toward and
	 * away from the viewer, which is what the depth cue is scaled by.
	 */
	ring: number;
	/** Where on that circle it starts, as a fraction of one revolution. */
	phase: number;
	/**
	 * Time to travel its circle, relative to the slowest dot's. The spread
	 * across latitudes is the differential rotation — see the note above.
	 */
	period: number;
	/** Dot diameter at the sphere's midpoint, as a fraction of the orb's size. */
	size: number;
	/** Opacity at that same midpoint, before the depth cue brightens or dims it. */
	dim: number;
}

export interface OrbOptions {
	/** How many dots the sphere is stippled with. */
	count?: number;
	/**
	 * Fraction of a polar dot's period that an equatorial one takes. Lower
	 * shears the bands past each other harder; at 1 the sphere turns as one
	 * rigid body and the effect is gone.
	 */
	shear?: number;
	/** Shifts every dot along its circle, so two orbs are not in lockstep. */
	turn?: number;
}

/** Rounded, so identical options always produce byte-identical markup. */
const round = (n: number): number => Math.round(n * 1e4) / 1e4;

/**
 * Dots spread over a unit sphere, each on its own circle of latitude.
 *
 * Latitude is drawn uniformly as a *height* rather than as an angle. That is
 * Archimedes' result — equal slices of a sphere's axis carry equal area — and
 * it is what spaces the dots evenly. Drawing the angle uniformly instead
 * crowds them into two bright caps joined by a sparse middle.
 */
export function orbDots(opts: OrbOptions = {}): OrbDot[] {
	const { count = 30, shear = 0.55, turn = 0 } = opts;
	if (count < 1) return [];
	const dots: OrbDot[] = [];
	for (let i = 0; i < count; i++) {
		// Half-step offsets, so the first dot is not pinned to a pole at the
		// exact start of its circle.
		const lat = frac(0.5 + i * STREAM_LAT);
		const jitter = frac(0.5 + i * STREAM_JITTER);
		// Held off the poles themselves, where a dot has no circle to travel and
		// sits motionless while everything around it moves.
		const latitude = (lat * 2 - 1) * 0.92;
		/*
		 * How far out from the centre this dot sits.
		 *
		 * Every dot rode the surface at first, and a hollow shell projects
		 * denser at its edge than through its middle — so the cluster drew as a
		 * ring with a hole in it rather than as a body. Filling the inside is
		 * what closes the hole. A fourth stream, because taking this off the
		 * jitter would have made the inner dots the big ones every time.
		 */
		const depth = 0.55 + 0.45 * frac(0.5 + i * STREAM_DEPTH);
		const phase = frac(0.5 + i * STREAM_LON + turn);
		// Differential rotation, floored by `shear` so the equator churns without
		// blurring. Read off the latitude rather than the scaled height: it is
		// the angle that says which band a dot belongs to, whatever depth it
		// sits at. The jitter is what keeps it loose — a band moving in perfect
		// lockstep reads as a machined ring rather than as a swirl.
		const period = (shear + (1 - shear) * Math.abs(latitude)) * (0.88 + 0.24 * jitter);
		dots.push({
			y: round(latitude * depth),
			ring: round(Math.sqrt(Math.max(0, 1 - latitude * latitude)) * depth),
			phase: round(phase),
			period: round(period),
			// A tenth of the orb at the smallest. Below roughly that the dots
			// stop reading as a body and start reading as dust, and the depth
			// cue — which works by growing them — has nothing to grow.
			size: round(0.1 + 0.07 * jitter),
			dim: round(0.46 + 0.32 * jitter)
		});
	}
	return dots;
}
