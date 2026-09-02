// Theme definitions shared by server (persistence) and client (editor).

import {
	DEFAULT_MONO_FONT,
	DEFAULT_UI_FONT,
	FONT_FACE_CSS,
	GALAXY_FONT_STACK,
	fontStack,
	isFontId
} from '$lib/fonts';

export interface Theme {
	/** Page background */
	bg: string;
	/** Pane/card background */
	bgPane: string;
	/** Body text — the default colour of ordinary prose */
	fg: string;
	/** Dimmed text: metadata, timestamps, secondary captions */
	fgDim: string;
	/**
	 * Titles and section headings.
	 *
	 * Separate from `accent` so a palette choice cannot silently set the contrast
	 * of every heading in the interface: headings used to be hard-coded to the
	 * accent, which meant picking an accent for looks decided readability too.
	 */
	heading: string;
	/** Form field labels and control captions */
	label: string;
	/** Accent (links, active states, primary buttons) */
	accent: string;
	/** Borders and separators */
	border: string;
	/** Errors and destructive actions */
	danger: string;
	/**
	 * Interface font, as an id from the font catalogue (see $lib/fonts).
	 *
	 * An id rather than a CSS stack: a stack was free text with no requirement
	 * that it end in a generic family, so one typo took the whole interface down
	 * to an unstyled default. An unknown id here simply renders the default face.
	 */
	fontUi: string;
	/** Code font, same rules. Used for code, preformatted text and all numbers. */
	fontMono: string;
	/** Corner radius for buttons/controls, e.g. "5px" or "999px" */
	radius: string;
	/**
	 * Root font size. A percentage (e.g. '106%') resolves against the browser's
	 * own default, so anyone who has set a larger base size keeps that
	 * relationship; a length ('16px') pins it absolutely. Both are accepted.
	 */
	baseFont: string;
	/** Colour of the hover glow on buttons. */
	glow: string;
	/** Blur radius of that glow, e.g. '10px'. '0px' switches it off. */
	glowStrength: string;
	/** Ambient ASCII galaxy backdrop */
	galaxyBg: boolean;
	/** Slowly rotate the backdrop spiral (ignored when galaxyBg is off) */
	galaxyAnimate: boolean;
	/** Colour of the backdrop's characters (ignored when galaxyBg is off) */
	galaxyColor: string;
}

export const PRESETS: Record<string, Theme> = {
	Galaxy: {
		bg: '#05060f',
		bgPane: '#0a0c1a',
		fg: '#c8d0e8',
		fgDim: '#717994',
		heading: '#7f9cff',
		label: '#717994',
		accent: '#7f9cff',
		border: '#171a2e',
		danger: '#ff5d73',
		fontUi: 'quicksand',
		fontMono: 'source-code-pro',
		radius: '5px',
		baseFont: '100%',
		glow: '#7f9cff',
		glowStrength: '10px',
		galaxyBg: true,
		galaxyAnimate: true,
		galaxyColor: '#7f9cff'
	},
	Nebula: {
		bg: '#0a0512',
		bgPane: '#140a20',
		fg: '#e2d4f0',
		fgDim: '#84759b',
		heading: '#c084fc',
		label: '#84759b',
		accent: '#c084fc',
		border: '#241533',
		danger: '#fb7185',
		fontUi: 'quicksand',
		fontMono: 'source-code-pro',
		radius: '8px',
		baseFont: '100%',
		glow: '#c084fc',
		glowStrength: '12px',
		galaxyBg: true,
		galaxyAnimate: true,
		galaxyColor: '#c084fc'
	},
	Solar: {
		bg: '#0d0a04',
		bgPane: '#191207',
		fg: '#ede3cf',
		fgDim: '#8a7c5e',
		heading: '#fbbf24',
		label: '#8a7c5e',
		accent: '#fbbf24',
		border: '#2b2210',
		danger: '#f87171',
		fontUi: 'quicksand',
		fontMono: 'source-code-pro',
		radius: '3px',
		baseFont: '100%',
		glow: '#fbbf24',
		glowStrength: '10px',
		galaxyBg: true,
		galaxyAnimate: true,
		galaxyColor: '#fbbf24'
	},
	Void: {
		bg: '#000000',
		bgPane: '#0a0a0a',
		fg: '#e0e0e0',
		fgDim: '#797979',
		heading: '#ffffff',
		label: '#797979',
		accent: '#ffffff',
		border: '#1f1f1f',
		danger: '#ff4d4d',
		fontUi: 'quicksand',
		fontMono: 'source-code-pro',
		radius: '0px',
		baseFont: '94%',
		glow: '#ffffff',
		glowStrength: '8px',
		galaxyBg: false,
		galaxyAnimate: false,
		galaxyColor: '#ffffff'
	},
	Paper: {
		bg: '#f5f2ea',
		bgPane: '#ffffff',
		fg: '#2a2a33',
		fgDim: '#6e6e79',
		heading: '#3d5ccc',
		label: '#6e6e79',
		accent: '#3d5ccc',
		border: '#dcd8cc',
		danger: '#b8384e',
		fontUi: 'quicksand',
		fontMono: 'source-code-pro',
		radius: '6px',
		baseFont: '100%',
		glow: '#4c6ef5',
		glowStrength: '7px',
		galaxyBg: false,
		galaxyAnimate: false,
		galaxyColor: '#3d5ccc'
	}
};

export const DEFAULT_THEME: Theme = PRESETS.Galaxy;

// The shipped defaults, asserted here so a preset edit cannot quietly change
// what an unrecognised font id falls back to.
if (DEFAULT_THEME.fontUi !== DEFAULT_UI_FONT || DEFAULT_THEME.fontMono !== DEFAULT_MONO_FONT) {
	throw new Error('DEFAULT_THEME must use the catalogue defaults');
}

export function themeCss(t: Theme): string {
	return [
		FONT_FACE_CSS,
		':root{',
		`--bg:${t.bg};`,
		`--bg-pane:${t.bgPane};`,
		`--fg:${t.fg};`,
		`--fg-dim:${t.fgDim};`,
		`--heading:${t.heading};`,
		`--label:${t.label};`,
		`--galaxy:${t.galaxyColor};`,
		`--accent:${t.accent};`,
		`--border:${t.border};`,
		// Derived rather than configurable: a separator at 1.2:1 is fine, and a
		// text field whose only boundary is that same colour is invisible. See
		// controlBorder().
		`--control-border:${controlBorder(t)};`,
		`--danger:${t.danger};`,
		`--font-ui:${fontStack(t.fontUi, 'ui')};`,
		`--font-mono:${fontStack(t.fontMono, 'mono')};`,
		// Fixed, and deliberately not from the theme: the ASCII backdrop is art
		// made of characters, and a proportional or oddly-proportioned font
		// distorts the spiral. Nothing in Settings writes to this.
		`--font-galaxy:${GALAXY_FONT_STACK};`,
		`--radius:${t.radius};`,
		`--glow:${t.glow};`,
		`--glow-size:${t.glowStrength};`,
		'}',
		`html{font-size:${t.baseFont};}`,
		// One scale, six steps, instead of the twenty-five ad-hoc sizes this
		// interface had grown. Every size in the app names a step, so the whole
		// hierarchy can be tuned here rather than hunted through 390 rules.
		//
		// The floor is deliberate: `xs` at 0.78rem is about 12.5px at the default
		// root size, and nothing may go below it. The old floor was 0.58rem —
		// roughly 9px — which is not a size anyone should have to read, and the
		// switch to Quicksand made it worse, since it has a smaller x-height than
		// the monospace it replaced and so renders visually smaller at the same
		// declared size.
		':root{',
		'--text-xs:0.78rem;',
		'--text-sm:0.84rem;',
		'--text-base:0.9rem;',
		'--text-md:0.98rem;',
		'--text-lg:1.06rem;',
		'--text-xl:1.18rem;',
		'--text-2xl:1.35rem;',
		'}',
		// Digits in a proportional face are not equal width, so figures in a
		// column stop lining up. The monospace font is the fix; tabular-nums
		// costs nothing and helps in any face that carries tabular figures.
		'.num{font-family:var(--font-mono);font-variant-numeric:tabular-nums;}',
		// A control's border is the only thing saying where it is, so it needs the
		// 3:1 that WCAG asks of a meaningful boundary — unlike the card
		// separators that share the plain --border.
		'input,select,textarea{border-color:var(--control-border);}',
		// Visible text for screen readers only. Used where a control needs a name
		// but the layout has no room for a visible caption.
		'.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0;}',
		// Part of the design system rather than a per-component flourish: every
		// button lifts on hover, and one theme value tunes all of them at once.
		// A strength of 0 collapses the shadow, which is how it is switched off.
		'button:not(:disabled):hover{box-shadow:0 0 var(--glow-size) var(--glow);}',
		// The glow itself is not motion; the fade to it is. Anyone who has asked
		// for less motion gets the state change without the animation.
		'@media (prefers-reduced-motion: no-preference){button{transition:box-shadow .15s ease;}}'
	].join('');
}

/**
 * Colours split out of an existing token, and the token each one inherits from
 * when a stored theme predates it.
 *
 * The inheritance is the point. Filling these from DEFAULT_THEME like every
 * other field would hand a saved theme with an orange accent Galaxy's blue
 * headings — a theme someone tuned would change appearance on upgrade. Taking
 * the value from the *same theme's* accent/dim reproduces exactly what these
 * colours were hard-coded to before they were configurable.
 */
const DERIVED_FROM: { key: keyof Theme; from: keyof Theme }[] = [
	{ key: 'heading', from: 'accent' },
	{ key: 'label', from: 'fgDim' },
	{ key: 'galaxyColor', from: 'accent' }
];

/**
 * Keep persisted themes shaped like a Theme even across future field changes.
 * String values are emitted into a <style> tag, so anything that could break
 * out of a CSS declaration is rejected (defence against stored self-XSS).
 */
export function normalizeTheme(raw: unknown): Theme {
	const r = (raw ?? {}) as Record<string, unknown>;
	const out = { ...DEFAULT_THEME };
	const accepted = new Set<keyof Theme>();
	for (const key of Object.keys(DEFAULT_THEME) as (keyof Theme)[]) {
		const v = r[key];
		if (typeof DEFAULT_THEME[key] === 'boolean') {
			if (typeof v === 'boolean') {
				(out as Record<string, unknown>)[key] = v;
				accepted.add(key);
			}
		} else if (key === 'fontUi' || key === 'fontMono') {
			// Checked against the catalogue rather than pattern-matched for
			// dangerous characters. A theme saved before the split carries a raw
			// CSS stack in `font`, which is not an id and is therefore dropped —
			// so those themes come back on the new defaults, deliberately.
			if (isFontId(v)) {
				(out as Record<string, unknown>)[key] = v;
				accepted.add(key);
			}
		} else if (typeof v === 'string' && v.length < 200 && !/[<>{};\\]/.test(v)) {
			(out as Record<string, unknown>)[key] = v;
			accepted.add(key);
		}
	}
	// Runs after the loop, so it reads the incoming theme's own (already
	// validated) accent and dim rather than the defaults.
	for (const { key, from } of DERIVED_FROM) {
		if (!accepted.has(key)) (out as Record<string, unknown>)[key] = out[from];
	}
	return out;
}

/** Parse `#rgb` / `#rrggbb` to 0-255 channels. Null for anything else. */
function parseHex(colour: string): [number, number, number] | null {
	const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(colour.trim());
	if (!m) return null;
	const h = m[1];
	const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
	return [
		parseInt(full.slice(0, 2), 16),
		parseInt(full.slice(2, 4), 16),
		parseInt(full.slice(4, 6), 16)
	];
}

/** WCAG relative luminance of an sRGB channel triple. */
function luminance([r, g, b]: [number, number, number]): number {
	const lin = [r, g, b].map((v) => {
		const c = v / 255;
		return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
	});
	return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

/**
 * WCAG 2.1 contrast ratio between two colours, 1–21.
 *
 * Returns 0 — not 1 — when either colour cannot be parsed, so the editor can
 * tell "no answer" from "no contrast" and render a dash instead of a failure.
 */
export function contrastRatio(a: string, b: string): number {
	const ca = parseHex(a);
	const cb = parseHex(b);
	if (!ca || !cb) return 0;
	const la = luminance(ca);
	const lb = luminance(cb);
	const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
	return (hi + 0.05) / (lo + 0.05);
}

/**
 * Grade a ratio for body-sized text. `AA-large` is the honest middle: it clears
 * the large-text threshold (3:1) but not the 4.5:1 normal text needs, which is
 * exactly the band a heading colour tends to land in.
 */
export function contrastGrade(ratio: number): 'AAA' | 'AA' | 'AA-large' | 'fail' {
	if (ratio >= 7) return 'AAA';
	if (ratio >= 4.5) return 'AA';
	if (ratio >= 3) return 'AA-large';
	return 'fail';
}

/**
 * Whether a background is light enough that adding light to it does nothing.
 *
 * The Cortex map draws its glow additively, which is right on the four dark
 * presets and useless on Paper: adding light to cream reaches white almost
 * immediately, so a hub and a leaf both render as the same pale smudge. The map
 * asks this and inverts — on a light page a glow is ink bleeding outward from a
 * saturated core, not light being added.
 *
 * A threshold rather than a preset list, because themes are hand-editable and a
 * light theme somebody wrote themselves has the same problem. Relative
 * luminance is not perceived lightness — 50% sRGB grey measures 0.216, not 0.5
 * — so the line sits at 0.35, comfortably above mid grey and nowhere near
 * either side of what ships: Paper measures 0.87 and the four dark presets are
 * all under 0.005. Below it there is enough headroom for adding light to still
 * mean something.
 *
 * Unparseable colours read as dark, which is the majority case and the one that
 * behaves exactly as it did before this existed.
 */
export function isLight(colour: string): boolean {
	const rgb = parseHex(colour);
	return rgb ? luminance(rgb) > 0.35 : false;
}

/**
 * A border colour for form controls that is actually visible.
 *
 * `--border` does two jobs: it separates cards, where 1.2:1 is a deliberate
 * whisper, and it outlines text fields, where it is the only thing saying a
 * control is there at all. WCAG 1.4.11 asks 3:1 of the second. Splitting them
 * into two settable colours would mean asking everyone to tune one more swatch
 * and getting it wrong on every theme saved before today, so this derives the
 * second from the first: step `border` toward `fg` until it clears 3:1 against
 * the page, and stop.
 *
 * Falls back to `fg` if either colour is unparseable — an over-strong border is
 * a great deal better than an invisible field.
 */
export function controlBorder(t: Theme, target = 3): string {
	const from = parseHex(t.border);
	const to = parseHex(t.fg);
	const bg = t.bg;
	if (!from || !to) return t.fg;
	if (contrastRatio(t.border, bg) >= target) return t.border;

	for (let i = 1; i <= 100; i++) {
		const mixed = hexOf(from.map((v, k) => v + (to[k] - v) * (i / 100)) as [number, number, number]);
		if (contrastRatio(mixed, bg) >= target) return mixed;
	}
	return t.fg;
}

function hexOf([r, g, b]: [number, number, number]): string {
	return (
		'#' +
		[r, g, b]
			.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'))
			.join('')
	);
}
