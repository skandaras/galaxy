// Theme definitions shared by server (persistence) and client (editor).

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
	/** Font stack */
	font: string;
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
		fgDim: '#5a627e',
		heading: '#7f9cff',
		label: '#5a627e',
		accent: '#7f9cff',
		border: '#171a2e',
		danger: '#ff5d73',
		font: "'SF Mono', ui-monospace, 'Cascadia Code', Menlo, monospace",
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
		fgDim: '#71618a',
		heading: '#c084fc',
		label: '#71618a',
		accent: '#c084fc',
		border: '#241533',
		danger: '#fb7185',
		font: "'SF Mono', ui-monospace, 'Cascadia Code', Menlo, monospace",
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
		font: "'SF Mono', ui-monospace, 'Cascadia Code', Menlo, monospace",
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
		fgDim: '#6a6a6a',
		heading: '#ffffff',
		label: '#6a6a6a',
		accent: '#ffffff',
		border: '#1f1f1f',
		danger: '#ff4d4d',
		font: "ui-monospace, 'Cascadia Code', Menlo, monospace",
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
		fgDim: '#8a8a96',
		heading: '#4c6ef5',
		label: '#8a8a96',
		accent: '#4c6ef5',
		border: '#dcd8cc',
		danger: '#d6455d',
		font: "'SF Mono', ui-monospace, Menlo, monospace",
		radius: '6px',
		baseFont: '100%',
		glow: '#4c6ef5',
		glowStrength: '7px',
		galaxyBg: false,
		galaxyAnimate: false,
		galaxyColor: '#4c6ef5'
	}
};

export const DEFAULT_THEME: Theme = PRESETS.Galaxy;

export function themeCss(t: Theme): string {
	return [
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
		`--danger:${t.danger};`,
		`--font-mono:${t.font};`,
		`--radius:${t.radius};`,
		`--glow:${t.glow};`,
		`--glow-size:${t.glowStrength};`,
		'}',
		`html{font-size:${t.baseFont};}`,
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
