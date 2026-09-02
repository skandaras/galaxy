/**
 * What colour an area is, and therefore what colour its concepts draw in.
 *
 * Pure, and outside both the chart and the panel, because three separate copies
 * of this rule had grown: the chart built an `hsl()` string, the panel built a
 * `#rrggbb` for its colour input, and each derived the hue from its own copy of
 * the same slot arithmetic. Three copies of a colour rule is a map that
 * disagrees with the list beside it the first time either is edited.
 *
 * The hue is hashed from the area's **id**, which is the whole point of this
 * file. It used to come from the area's position in the sorted set of ids on
 * nodes, and sorted position is exactly what an insert disturbs: filing
 * something under a new area that sorted early walked every other area's hue
 * along a slot, so a map somebody had tuned by hand came back different. Hashing
 * makes an area's colour a permanent property of that area — it survives other
 * areas being added, removed or recoloured, and it survives a rename too, since
 * renaming writes `name` and never `id`.
 *
 * What hashing costs is even spacing. Positions on a wheel are as far apart as
 * they can be; hashes are not, and with a handful of areas two will eventually
 * land close enough to be told apart only by looking hard. Hence the shade
 * below, and hence the colour picker, which is the real answer when it matters.
 */
import { hash01 } from '$lib/alignment-constellation';

/**
 * Salts, so one id yields three independent streams — the same trick
 * `layoutStars` uses to get an angle, a shell and a jitter out of one id. All
 * non-zero: `hash01('', 0)` is exactly 0, and while a circuit id is a slug and
 * never empty, a hash that has one input mapping to a corner is not one to
 * build three values on.
 */
const HUE_SALT = 0x9e;
const SATURATION_SALT = 0x37;
const LIGHTNESS_SALT = 0x5b;

export interface AreaShade {
	h: number;
	s: number;
	l: number;
}

/**
 * A hue, and a little variation in shade to go with it.
 *
 * Saturation and lightness used to be fixed at 52% and 62% — chosen so a hue
 * stays legible against both a near-black and a cream page — and they are still
 * the middle of the bands here. The bands exist because hue alone is one
 * dimension and hashes collide in it: two areas a couple of degrees apart are
 * the same colour to look at, but two areas a couple of degrees apart where one
 * is lighter and flatter are not. Deliberately narrow, because the reason those
 * two numbers were fixed in the first place has not gone away.
 */
export function areaShade(id: string): AreaShade {
	return {
		h: hash01(id, HUE_SALT) * 360,
		s: 46 + hash01(id, SATURATION_SALT) * 14,
		l: 55 + hash01(id, LIGHTNESS_SALT) * 13
	};
}

/** For a canvas `fillStyle` and for CSS, which both take `hsl()` happily. */
export function areaColourCss(id: string): string {
	const { h, s, l } = areaShade(id);
	return `hsl(${h.toFixed(1)} ${s.toFixed(1)}% ${l.toFixed(1)}%)`;
}

/**
 * The same colour as `#rrggbb`.
 *
 * Only for `<input type="color">`, which has no empty state and silently
 * ignores anything that is not a six-digit hex — so an area with no colour set
 * has to open its picker on the colour it is currently drawn in, or the picker
 * opens on black and says the area is black, which it is not.
 */
export function areaHueHex(id: string): string {
	const { h, s, l } = areaShade(id);
	return hslToHex(h, s, l);
}

/**
 * Standard HSL to RGB. `f` is the piecewise-linear channel curve, evaluated at
 * the three phase offsets red, green and blue sit at.
 *
 * Exported so a test can check the two outputs above describe one colour rather
 * than two that happen to look similar.
 */
export function hslToHex(hDeg: number, sPct: number, lPct: number): string {
	const h = (((hDeg % 360) + 360) % 360) / 360;
	const s = sPct / 100;
	const l = lPct / 100;
	const a = s * Math.min(l, 1 - l);
	const f = (n: number) => {
		const k = (n + h * 12) % 12;
		const v = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
		return Math.round(v * 255)
			.toString(16)
			.padStart(2, '0');
	};
	return `#${f(0)}${f(8)}${f(4)}`;
}
