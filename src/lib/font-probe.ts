/**
 * Is a font family actually installed on this machine?
 *
 * The browser gives no direct answer, so this uses the standard measurement
 * trick: render a string in `"<family>", <generic>` and in the generic alone. If
 * the family is missing, the browser falls through to the generic and the two
 * widths match exactly. If it is present, they almost certainly differ.
 *
 * Compared against all three generics rather than one, because a family that
 * happens to be metrically identical to one of them would otherwise read as
 * absent — and a monospace face compared only against `sans-serif` gives a false
 * positive for anything.
 *
 * This is advisory. The dropdown uses it to say "not on this device" beside an
 * option, never to remove one: a theme travels between machines, and a font
 * missing here may well be present on the phone.
 */

const PROBE_TEXT = 'mmmmmmmmmmlliWWQ0123456789';
const PROBE_SIZE = '72px';
const GENERICS = ['monospace', 'sans-serif', 'serif'] as const;

/** Measures a string at a given font-family. Injected so this stays testable. */
export type Measure = (text: string, fontFamily: string) => number;

/**
 * Pure so the logic can be tested without a canvas: given a way to measure,
 * decide whether the family rendered as itself or fell through.
 */
export function isFontAvailable(family: string, measure: Measure): boolean {
	return GENERICS.some((generic) => {
		const baseline = measure(PROBE_TEXT, `${PROBE_SIZE} ${generic}`);
		const candidate = measure(PROBE_TEXT, `${PROBE_SIZE} "${family}", ${generic}`);
		// Exact equality rather than a tolerance: falling through to the generic
		// means the *same* font measured twice, so any real difference — even a
		// fraction of a pixel — means the family was used.
		return candidate !== baseline;
	});
}

let canvasMeasure: Measure | null = null;

/** A real canvas measurer, made once and reused. Browser only. */
export function browserMeasure(): Measure | null {
	if (canvasMeasure) return canvasMeasure;
	if (typeof document === 'undefined') return null;
	const ctx = document.createElement('canvas').getContext('2d');
	if (!ctx) return null;
	canvasMeasure = (text, fontFamily) => {
		ctx.font = fontFamily;
		return ctx.measureText(text).width;
	};
	return canvasMeasure;
}

/**
 * Check several families at once. Anything without a `probe` family is treated
 * as available — that covers the faces we bundle and the stacks that name only
 * generics, neither of which can be missing.
 */
export function probeFonts(
	families: { id: string; probe?: string; bundled?: boolean }[],
	measure: Measure | null = browserMeasure()
): Record<string, boolean> {
	const out: Record<string, boolean> = {};
	for (const f of families) {
		if (f.bundled || !f.probe || !measure) {
			out[f.id] = true;
			continue;
		}
		out[f.id] = isFontAvailable(f.probe, measure);
	}
	return out;
}
