/**
 * Layout for the alignment constellation.
 *
 * Each rubric dimension is a star. How brightly it burns is how that dimension
 * has been reading lately; where it sits is fixed forever by its id, so the
 * shape of your sky stays recognisable from one week to the next and only the
 * light changes. A layout that reshuffled would make the whole thing unreadable
 * as a picture of anything.
 *
 * Everything here is pure and deterministic, which is what makes it testable and
 * what makes the positions stable across reloads.
 */

export interface StarInput {
	id: string;
	name: string;
	/** Where the dimension comes from, shown when a star is named. */
	tradition: string;
	/** Mean of recent readings, 1-5, or null when nothing has scored it. */
	recent: number | null;
	direction: 'rising' | 'steady' | 'falling' | 'unknown';
	/** Rubric weight, 1-5. Heavier dimensions draw slightly larger. */
	weight: number;
	count: number;
}

export interface Star extends StarInput {
	/** Fractions of the viewbox, 0-1. */
	x: number;
	y: number;
	/** Radius in viewbox units. */
	r: number;
	/** 0-1. Unscored dimensions sit at the floor rather than vanishing. */
	brightness: number;
	/** Whether it has ever been scored — an unlit star is a real state. */
	lit: boolean;
}

/** Stable hash of a string to [0,1). Same shape as galaxy-art's cell noise. */
export function hash01(text: string, salt = 0): number {
	let h = salt | 0;
	for (let i = 0; i < text.length; i++) {
		h = Math.imul(h ^ text.charCodeAt(i), 2654435761);
		h = h ^ (h >>> 15);
	}
	h = Math.imul(h ^ (h >>> 13), 1274126177);
	return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * The floor exists so an unscored dimension is visibly *there but unlit*,
 * rather than absent. "This has never come up" is information.
 */
const MIN_BRIGHTNESS = 0.14;

/**
 * Place the stars on a ring, evenly by index with a per-id wobble.
 *
 * Evenly spaced alone looks like a clock face; pure hash placement clumps and
 * leaves holes. Index for the spread, hash for the character.
 */
export function layoutStars(dimensions: StarInput[]): Star[] {
	const n = dimensions.length;
	if (!n) return [];

	return dimensions.map((d, i) => {
		const wobble = hash01(d.id, 7) - 0.5;
		const angle = ((i + 0.5) / n) * Math.PI * 2 + wobble * (Math.PI / n) * 0.9;
		// Two loose shells, so it reads as a sky rather than a dial.
		const shell = hash01(d.id, 13) < 0.5 ? 0.3 : 0.42;
		const radius = shell + (hash01(d.id, 29) - 0.5) * 0.06;

		const brightness =
			d.recent === null
				? MIN_BRIGHTNESS
				: MIN_BRIGHTNESS + ((clamp(d.recent, 1, 5) - 1) / 4) * (1 - MIN_BRIGHTNESS);

		return {
			...d,
			x: 0.5 + Math.cos(angle) * radius,
			// Slightly flattened: a perfect circle reads as a diagram, an ellipse
			// reads as a sky.
			y: 0.5 + Math.sin(angle) * radius * 0.84,
			r: 0.012 + (clamp(d.weight, 1, 5) / 5) * 0.016 + brightness * 0.012,
			brightness,
			lit: d.count > 0
		};
	});
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Lines between neighbouring stars, so it reads as a constellation and not a
 * scatter plot. Purely decorative: the pairs mean nothing, and the code should
 * never pretend otherwise by connecting "related" dimensions.
 */
export function constellationLines(stars: Star[]): { x1: number; y1: number; x2: number; y2: number }[] {
	if (stars.length < 2) return [];
	return stars.map((star, i) => {
		const next = stars[(i + 1) % stars.length];
		return { x1: star.x, y1: star.y, x2: next.x, y2: next.y };
	});
}

/** The arrow a direction gets. Neutral glyphs — this is not a scoreboard. */
export const DIRECTION_GLYPH: Record<StarInput['direction'], string> = {
	rising: '↗',
	steady: '→',
	falling: '↘',
	unknown: '·'
};
