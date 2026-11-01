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

/**
 * The controls every page draws, declared once.
 *
 * Each of these lived as a scoped copy in every component that used it: `.btn`
 * in 25 files, `.card` in 16, with five paddings, three disabled treatments and
 * two meanings of "danger" between them. Worse than the drift was what a scoped
 * copy overrides: the corner radius and the control border the theme sets never
 * reached a button whose own rule named 5px and --border.
 *
 * A component may still add a modifier of its own (`.btn.send`), but must not
 * restate one of these: a scoped `.btn` compiles to two classes and ties with
 * `.btn.primary` here, so which one wins comes down to stylesheet order.
 */
const BASE_CONTROLS = [
	// The reading column Chat and Code share. Replies ran the full width of the
	// pane, around 150 characters to a line on a desktop, which is a lot of
	// eye travel for prose. One value so the two pages and the composer agree.
	':root{--radius-lg:calc(var(--radius) * 1.6);--radius-sm:calc(var(--radius) * 0.6);--thread-measure:44rem;}',
	// min-height is --tap, so a button meets 32px with a mouse and the 44px
	// docs/ACCESSIBILITY.md commits to under a finger, without each page
	// remembering to ask for it.
	'.btn{display:inline-flex;align-items:center;justify-content:center;gap:.35rem;box-sizing:border-box;min-height:var(--tap);padding:.35rem .7rem;background:var(--border);color:var(--fg);border:1px solid transparent;border-radius:var(--radius);font-family:inherit;font-size:var(--text-base);line-height:1.2;text-decoration:none;cursor:pointer;}',
	// A fill that runs from the accent to its neighbour on the hue circle. The
	// whole run is held to AA under --bg text (gradientPartner), so the label
	// reads wherever it sits; the solid accent stays underneath for anything
	// without gradient support.
	'.btn.primary{background:var(--accent);background-image:linear-gradient(135deg,var(--accent),var(--accent-2));color:var(--bg);}',
	'.btn.ghost{background:transparent;border:1px dashed var(--fg-dim);color:var(--fg-dim);}',
	'.btn.danger{background:transparent;border-color:var(--danger);color:var(--danger);}',
	'.btn.wide{width:100%;}',
	'.btn:disabled,.chip:disabled{opacity:.5;cursor:default;}',
	// A chip is a toggle, so its outline is a control boundary and takes the
	// 3:1 border rather than the separator colour it used to borrow.
	'.chip{display:inline-flex;align-items:center;gap:.3rem;box-sizing:border-box;min-height:var(--tap);padding:.25rem .7rem;background:transparent;border:1px solid var(--control-border);border-radius:999px;color:var(--fg-dim);font-family:inherit;font-size:var(--text-base);cursor:pointer;}',
	'.chip.on{border-color:var(--accent);color:var(--accent);box-shadow:inset 0 0 0 1px var(--accent-wash),0 0 calc(var(--glow-size) * .8) -2px var(--glow);}',
	// The edge is drawn by a pseudo-element masked to a 1px ring, so it can be a
	// gradient and still follow the corner radius, which border-image cannot.
	// The solid --border underneath is what shows where masks are unsupported.
	'.card{position:relative;border:1px solid var(--border);border-radius:var(--radius-lg);padding:.9rem;margin-bottom:.9rem;background:var(--surface);}',
	'.card::before,.edge::before{content:"";position:absolute;inset:-1px;border-radius:inherit;padding:1px;background:linear-gradient(135deg,var(--edge),transparent 38%,transparent 62%,var(--edge));-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask:linear-gradient(#000 0 0) content-box exclude,linear-gradient(#000 0 0);pointer-events:none;}',
	'.edge{position:relative;}',
	// The raised surface for the rail, bars, sheets and popovers. Opaque, with no
	// backdrop-filter, for two reasons found the hard way. Translucent, a popover
	// over a white image in a reply composited to about #40414c and dim text fell
	// to 2.34:1; the AA tests can only hold a colour that is actually drawn. And
	// a backdrop-filter makes its element the containing block for every fixed
	// descendant: on the rail it clipped the alerts panel at the rail's edge on a
	// desktop and hid it inside the top strip on a phone.
	'.glass{background:var(--surface-glass);}',
	// A divider that fades out at both ends, so a section break reads as light
	// across the panel rather than a ruled line.
	'.rule{height:1px;border:none;margin:.9rem 0;background:linear-gradient(90deg,transparent,var(--edge) 20%,var(--border) 50%,var(--edge) 80%,transparent);}',
	// The small uppercase label over a group, which seventy-odd rules each spelt
	// out with their own letter-spacing.
	'.eyebrow{font-size:var(--text-xs);letter-spacing:.16em;text-transform:uppercase;color:var(--label);}',
	'.hint{font-size:var(--text-sm);color:var(--fg-dim);line-height:1.5;}',
	'.notice{font-size:var(--text-base);color:var(--accent);}',
	'.notice.error{color:var(--danger);}',
	// A button that reads as a link. Eight components each declared their own,
	// most at padding 0, which put the hover glow and the focus ring flush on the
	// letters. `.inline` is for one inside a sentence: the negative margin keeps
	// the words around it where they were while the glow still gets room.
	'.link{padding:.2rem .45rem;background:none;border:none;border-radius:var(--radius);font:inherit;color:var(--accent);text-decoration:underline;cursor:pointer;}',
	'.link.inline{padding:0 .2rem;margin:0 -.2rem;}',
	'.badge{display:inline-block;font-size:var(--text-xs);border:1px solid var(--accent);color:var(--accent);border-radius:3px;padding:0 .25rem;text-transform:uppercase;}',
	'.tabs{display:flex;flex-wrap:wrap;gap:.3rem;border-bottom:1px solid var(--border);margin-bottom:1rem;}',
	'.tabs button{background:none;border:none;border-bottom:2px solid transparent;border-radius:0;color:var(--fg-dim);font-family:inherit;font-size:var(--text-md);padding:.5rem .8rem;cursor:pointer;}',
	'.tabs button[aria-selected="true"]{color:var(--fg);border-bottom-color:var(--accent);}',
	// Motion the components share instead of each declaring its own pulse.
	'@keyframes galaxy-pulse{50%{opacity:.35}}',
	'@keyframes galaxy-rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}',
	'@media (prefers-reduced-motion: no-preference){.tabs button{transition:color var(--dur-1) var(--ease-out),border-color var(--dur-2) var(--ease-out);}.chip,.nav-item{transition:color var(--dur-1) var(--ease-out),background-color var(--dur-1) var(--ease-out),border-color var(--dur-1) var(--ease-out);}}'
];

/**
 * Every custom property a theme sets on :root, plus its colour scheme, as one
 * map. themeCss writes the stylesheet from it and the theme editor's live
 * preview applies it inline, so a token added here reaches both. The preview
 * kept its own list once, and the derived tokens never made it in: previewing
 * Paper over Galaxy drew Paper's dark text on Galaxy's dark cards at 1.39:1.
 */
export function themeVars(t: Theme): Record<string, string> {
	const d = deriveTokens(t);
	return {
		'--bg': t.bg,
		'--bg-pane': t.bgPane,
		'--fg': t.fg,
		'--fg-dim': t.fgDim,
		'--heading': t.heading,
		'--label': t.label,
		'--galaxy': t.galaxyColor,
		'--accent': t.accent,
		'--border': t.border,
		// Derived rather than configurable: a separator at 1.2:1 is fine, and a
		// text field whose only boundary is that same colour is invisible. See
		// controlBorder().
		'--control-border': controlBorder(t),
		'--danger': t.danger,
		'--font-ui': fontStack(t.fontUi, 'ui'),
		'--font-mono': fontStack(t.fontMono, 'mono'),
		'--radius': t.radius,
		'--glow': t.glow,
		'--glow-size': t.glowStrength,
		'--accent-2': d.accent2,
		'--accent-wash': d.accentWash,
		'--surface': d.surface,
		'--surface-glass': d.surfaceGlass,
		'--edge': d.edge,
		'--success': d.success,
		// The browser's own controls and scrollbars, which follow this rather
		// than the theme. app.html still says dark, for the paint before this
		// style exists (the app renders client-side, and a light canvas there
		// flashes white under a dark theme); this overrides it once it lands,
		// so Paper stops drawing dark scrollbars and form controls.
		'color-scheme': d.light ? 'light' : 'dark'
	};
}

export function themeCss(t: Theme): string {
	const vars = Object.entries(themeVars(t)).map(([name, value]) => `${name}:${value};`);
	return [
		FONT_FACE_CSS,
		':root{',
		...vars,
		// Fixed, and deliberately not from the theme: the ASCII backdrop is art
		// made of characters, and a proportional or oddly-proportioned font
		// distorts the spiral. Nothing in Settings writes to this.
		`--font-galaxy:${GALAXY_FONT_STACK};`,
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
		// Geometry and stacking order. Deliberately not part of the Theme object:
		// nothing in Settings writes to these, and normalizeTheme never sees them.
		// They live here because this is the only place that emits global CSS, so
		// the whole ladder is greppable in one file instead of spread across the
		// seventeen component <style> blocks that used to hold the numbers.
		//
		// Two axes, kept apart on purpose. Width decides layout — what is fixed,
		// what scrolls, what is hidden — and lives in the components' own media
		// queries. Capability decides size, and lives in the (pointer: coarse)
		// block below. A rule that mixes the two is a bug in this scheme: it is
		// what gives a narrow desktop window thumb-sized chrome it has no use for.
		':root{',
		// The floor a control may not go under. 44px is the figure
		// docs/ACCESSIBILITY.md commits to for a finger; a mouse is precise enough
		// that spending the same vertical room on every button is just waste, so
		// the coarse-pointer block raises it rather than this being one value.
		'--tap:32px;',
		'--strip-h:44px;',
		'--tabbar-h:40px;',
		// How much of the viewport the software keyboard is covering, written from
		// JS by attachViewport(). Zero until something says otherwise, so a
		// browser that cannot report it behaves as though the keyboard is shut.
		'--kbd:0px;',
		'}',
		// Spacing, shadow and motion, named once so components stop inventing
		// their own. Shadows darken by a fixed amount whatever the theme; on a
		// light page they are softer because there is less to darken.
		':root{',
		'--space-1:.25rem;--space-2:.5rem;--space-3:.75rem;--space-4:1rem;--space-5:1.5rem;--space-6:2rem;',
		'--shadow-1:0 1px 2px rgb(0 0 0 / .25),0 2px 8px rgb(0 0 0 / .18);',
		'--shadow-2:0 6px 20px rgb(0 0 0 / .38);',
		'--shadow-3:0 -8px 28px rgb(0 0 0 / .4);',
		'--ease-out:cubic-bezier(.2,.8,.2,1);',
		'--ease-spring:cubic-bezier(.32,1.25,.5,1);',
		'--dur-1:120ms;--dur-2:200ms;--dur-3:320ms;',
		'}',
		// The stacking order, as names. Every one of these was a bare number in a
		// component before, and the numbers had drifted into three clusters with
		// gaps nobody could explain — 40 for a drag ghost that floated over the
		// chrome, two different things both claiming 60.
		//
		// Chrome sits above the sheet, which looks wrong until you follow it: the
		// alerts panel is a descendant of the top strip, so it paints in the
		// strip's stacking context whatever number it carries. Ordering chrome
		// above the sheet is what puts that panel over the page drawers, rather
		// than a special case for the panel.
		':root{',
		'--z-backdrop:0;',
		'--z-base:1;',
		'--z-drag:10;',
		'--z-drawer:20;',
		'--z-sheet:30;',
		'--z-chrome:40;',
		// Above chrome, unlike the drag ghost: a card detail below 900px is
		// inset:0 and takes the screen, so a tab bar painted over it would sit on
		// top of the thing being read.
		'--z-modal:45;',
		'--z-scrim:50;',
		'--z-popover:51;',
		'}',
		// Everything that changes because a finger is imprecise, and nothing that
		// changes because a window is narrow.
		'@media (pointer: coarse){',
		':root{--tap:44px;--tabbar-h:56px;}',
		// Safari zooms the whole viewport when a focused control's text is under
		// 16px, and then leaves it zoomed. The scale here tops out at --text-2xl
		// (1.35rem) but most controls name --text-base (0.9rem), and the Void
		// preset puts html at 94% on top of that — so nearly every input in the
		// app trips it. !important because this has to beat the scoped class
		// Svelte compiles into each component's own font-size, which outranks a
		// bare element selector; the alternative was editing every control by hand
		// and hoping the next one remembers.
		'input,select,textarea{font-size:max(16px,1em)!important;}',
		'}',
		// Digits in a proportional face are not equal width, so figures in a
		// column stop lining up. The monospace font is the fix; tabular-nums
		// costs nothing and helps in any face that carries tabular figures.
		'.num{font-family:var(--font-mono);font-variant-numeric:tabular-nums;}',
		// A control's border is the only thing saying where it is, so it needs the
		// 3:1 that WCAG asks of a meaningful boundary — unlike the card
		// separators that share the plain --border.
		'input,select,textarea{border-color:var(--control-border);}',
		// Nine rules across the tree removed the focus outline and put nothing
		// back, so a keyboard user lost their place entirely — docs/ACCESSIBILITY
		// listed it as the first thing worth fixing. Declared once, here, rather
		// than as nine :focus-visible rules that can each be forgotten again.
		// :focus-visible, not :focus, so a mouse click does not draw it.
		'a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,[tabindex]:focus-visible{outline:2px solid var(--accent);outline-offset:2px;}',
		// Visible text for screen readers only. Used where a control needs a name
		// but the layout has no room for a visible caption.
		'.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0;}',
		// Part of the design system rather than a per-component flourish: every
		// button lifts on hover, and one theme value tunes all of them at once.
		// A strength of 0 collapses the shadow, which is how it is switched off.
		'button:not(:disabled):hover{box-shadow:0 0 var(--glow-size) var(--glow);}',
		// The glow itself is not motion; the fade to it is. Anyone who has asked
		// for less motion gets the state change without the animation.
		'@media (prefers-reduced-motion: no-preference){button{transition:box-shadow .15s ease;}}',
		// The safety net under every component's own opt-out. Nine animations had
		// none, so a person who had asked for less motion still got pulses and
		// slides; this stops all of them at once, and any added later.
		'@media (prefers-reduced-motion: reduce){*,*::before,*::after{animation-duration:.001ms!important;animation-iteration-count:1!important;transition-duration:.001ms!important;scroll-behavior:auto!important;}}',
		// These two used to be appended by +layout.svelte inside the same style
		// tag, which made the claim above that this is the only place emitting
		// global CSS untrue.
		'button,input,select,textarea{border-radius:var(--radius);}',
		// touch-action is here rather than on each control because the failure
		// it fixes is not any one component's. iOS keeps double-tap-to-zoom on a
		// width=device-width page (Chrome drops it, Safari does not) and the
		// gesture recogniser can swallow the second tap of a quick pair on the
		// same element. The tab bar's "tap the tab you are already on" is that
		// pair, so whether it worked came down to how fast the thumb was.
		'button,a,input,select,textarea{touch-action:manipulation;}',
		...BASE_CONTROLS
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

/** Same appearance, field by field. Hex case is not a difference anyone can see. */
export function sameTheme(a: unknown, b: unknown): boolean {
	const x = normalizeTheme(a);
	const y = normalizeTheme(b);
	return (Object.keys(DEFAULT_THEME) as (keyof Theme)[]).every((key) => {
		const u = x[key];
		const v = y[key];
		return typeof u === 'string' && typeof v === 'string' ? u.toLowerCase() === v.toLowerCase() : u === v;
	});
}

export type ThemeOrigin = { kind: 'preset' | 'custom'; name: string };

/**
 * Which chip in the editor the active theme is.
 *
 * Worked out from the values rather than stored beside them. The editor used
 * to keep no record of where a theme came from, so saving edits wrote the
 * active theme and left the chip it was opened from as it was: clicking that
 * chip again brought back the version from before the save, and the theme
 * actually in use had no chip at all. Matching by value needs no migration for
 * themes saved before, and cannot fall out of step with what is stored.
 *
 * Your own themes are checked first, so a copy of a built-in you have named
 * is the one shown as selected. Null means no chip matches: a theme saved
 * before this, an import, or a saved theme that was then deleted.
 */
export function themeOrigin(
	active: Theme,
	presets: Record<string, Theme>,
	custom: Record<string, Theme>
): ThemeOrigin | null {
	for (const [name, t] of Object.entries(custom)) if (sameTheme(active, t)) return { kind: 'custom', name };
	for (const [name, t] of Object.entries(presets)) if (sameTheme(active, t)) return { kind: 'preset', name };
	return null;
}

/** The first of "Galaxy 2", "Galaxy 3"… not already taken, ignoring case. */
export function freeName(base: string, taken: string[]): string {
	const used = new Set(taken.map((n) => n.toLowerCase()));
	for (let i = 2; ; i++) {
		const name = `${base.slice(0, 36)} ${i}`;
		if (!used.has(name.toLowerCase())) return name;
	}
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

/**
 * Colours the interface derives from a theme rather than asking for: the second
 * accent a gradient runs to, the glass a panel is made of, the hairline at an
 * edge, a success green. Computed here, in hex, rather than with `color-mix()`
 * or relative colour syntax in the stylesheet, so the AA tests can measure the
 * very colour that is drawn. A derived colour nobody can test is a contrast
 * regression waiting for the next preset.
 */
export interface DerivedTokens {
	/** The accent turned about 48° round the hue circle, held to AA under --bg text. */
	accent2: string;
	/** Panels and cards: the pane leaned toward the page. */
	surface: string;
	/** What a glass panel looks like over the page, for when blur is unavailable. */
	surfaceGlass: string;
	/** The accent at a whisper over the pane, for an active row's wash. */
	accentWash: string;
	/** A border lit by the accent, where a hairline catches the light. */
	edge: string;
	/** Done, saved, passing. Held to AA on the pane. */
	success: string;
	/** Whether the page is light, which decides the colour-scheme the browser draws. */
	light: boolean;
}

export function deriveTokens(t: Theme): DerivedTokens {
	const bg = parseHex(t.bg) ?? [5, 6, 15];
	const light = luminance(bg) > 0.4;
	const pane = t.bgPane;
	return {
		accent2: gradientPartner(t.accent, t.bg),
		surface: mixHex(pane, t.bg, 0.6),
		surfaceGlass: mixHex(pane, t.bg, GLASS_ALPHA),
		accentWash: mixHex(t.accent, pane, 0.12),
		edge: mixHex(t.accent, t.border, 0.45),
		success: withContrast(light ? '#1f7a45' : '#5fcf8a', pane, 4.5),
		light
	};
}

/** How much of the pane a raised surface carries over the page colour. */
const GLASS_ALPHA = 0.78;

/**
 * The second stop of the primary button's gradient: the accent's neighbour on
 * the hue circle, held to AA against --bg at every point the browser paints
 * between the two stops. Checking only the ends missed a saved theme with
 * accent #0077ff, which passed at both while the sRGB midpoint, #5162f2, sat
 * at 4.21:1 under the label. The partner is pushed further until the whole run
 * passes; if nothing does, the button stays flat on the accent, as it was.
 */
function gradientPartner(accent: string, bg: string): string {
	const turned = rotateHue(accent, 48);
	for (let min = 4.5; min <= 21; min += 0.25) {
		const end = withContrast(turned, bg, min);
		let reads = true;
		for (let i = 0; i <= 20 && reads; i++) reads = contrastRatio(bg, mixHex(end, accent, i / 20)) >= 4.5;
		if (reads) return end;
	}
	return accent;
}

/**
 * `a` laid over `b` at weight `t`, the way a browser composites, in sRGB.
 *
 * A colour that is not hex (a theme may carry `white` or `rgb(...)`, which
 * normalizeTheme accepts) cannot be mixed here, and then the answer is
 * whichever of the two dominates. It used to be `a` regardless, which made
 * the active row's wash, 12% accent over the pane, a solid accent: Void with
 * `accent: 'white'` drew pale text on a white row.
 */
export function mixHex(a: string, b: string, t: number): string {
	const ca = parseHex(a);
	const cb = parseHex(b);
	if (!ca || !cb) return t >= 0.5 ? a : b;
	return hexOf(ca.map((v, i) => v * t + cb[i] * (1 - t)) as [number, number, number]);
}

/** sRGB hex to OKLCH, the space where turning the hue keeps lightness put. */
export function hexToOklch(hex: string): [number, number, number] | null {
	const c = parseHex(hex);
	if (!c) return null;
	const [r, g, b] = c.map((v) => {
		const x = v / 255;
		return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
	});
	const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
	const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
	const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
	const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
	const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
	const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
	const C = Math.hypot(A, B);
	const H = ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360;
	return [L, C, H];
}

/** OKLCH back to sRGB hex, clipped into gamut. */
export function oklchToHex([L, C, H]: [number, number, number]): string {
	const h = (H * Math.PI) / 180;
	const A = C * Math.cos(h);
	const B = C * Math.sin(h);
	const l = Math.pow(L + 0.3963377774 * A + 0.2158037573 * B, 3);
	const m = Math.pow(L - 0.1055613458 * A - 0.0638541728 * B, 3);
	const s = Math.pow(L - 0.0894841775 * A - 1.291485548 * B, 3);
	const rgb = [
		4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
		-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
		-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
	].map((x) => {
		const v = Math.max(0, Math.min(1, x));
		return 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
	});
	return hexOf(rgb as [number, number, number]);
}

function rotateHue(hex: string, degrees: number): string {
	const lch = hexToOklch(hex);
	// A grey has no hue to turn; it stays itself and the gradient is flat.
	if (!lch || lch[1] < 0.02) return hex;
	return oklchToHex([lch[0], lch[1], (lch[2] + degrees) % 360]);
}

/**
 * The colour, moved in lightness until text in `against` reads on it (or it
 * reads on `against`) at `min`, by the smallest shift either way. Unchanged if
 * it already passes.
 *
 * Both directions are tried in step. Picking one from the ground's luminance
 * chose lighter for anything under 0.4, and a mid grey such as #999999 is
 * under it while white cannot reach 4.5:1 against it: the derived accent came
 * out white at 2.85:1 where black would have given 7.4.
 */
function withContrast(hex: string, against: string, min: number): string {
	if (contrastRatio(hex, against) >= min) return hex;
	const lch = hexToOklch(hex);
	if (!lch || !parseHex(against)) return hex;
	const at = (l: number) => oklchToHex([Math.max(0, Math.min(1, l)), lch[1], lch[2]]);
	for (let i = 1; i <= 100; i++) {
		for (const next of [at(lch[0] - 0.01 * i), at(lch[0] + 0.01 * i)]) {
			if (contrastRatio(next, against) >= min) return next;
		}
	}
	return contrastRatio('#000000', against) >= contrastRatio('#ffffff', against) ? '#000000' : '#ffffff';
}

function hexOf([r, g, b]: [number, number, number]): string {
	return (
		'#' +
		[r, g, b]
			.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'))
			.join('')
	);
}
