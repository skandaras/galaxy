import { describe, it, expect } from 'vitest';
import {
	DEFAULT_THEME,
	PRESETS,
	contrastGrade,
	contrastRatio,
	controlBorder,
	normalizeTheme,
	themeCss
} from './theme';
import { GALAXY_FONT_STACK } from './fonts';

describe('normalizeTheme', () => {
	it('accepts sane values', () => {
		const t = normalizeTheme({ accent: '#ff00aa', radius: '12px', galaxyBg: false });
		expect(t.accent).toBe('#ff00aa');
		expect(t.radius).toBe('12px');
		expect(t.galaxyBg).toBe(false);
	});

	it('rejects CSS/HTML breakout attempts, falling back to defaults', () => {
		const t = normalizeTheme({
			accent: 'red}</style><script>alert(1)</script>',
			fontUi: 'x; background: url(evil)',
			bg: '#000{',
			radius: '5px\\'
		});
		expect(t.accent).toBe(DEFAULT_THEME.accent);
		expect(t.fontUi).toBe(DEFAULT_THEME.fontUi);
		expect(t.bg).toBe(DEFAULT_THEME.bg);
		expect(t.radius).toBe(DEFAULT_THEME.radius);
		expect(themeCss(t)).not.toContain('script');
	});

	it('fills in fields a theme saved before they existed does not have', () => {
		// Custom themes are stored as whole objects, so every new field has to
		// survive loading one written by an older build.
		const older = { bg: '#111111', accent: '#00ff00' };
		const t = normalizeTheme(older);
		expect(t.bg).toBe('#111111');
		expect(t.glow).toBe(DEFAULT_THEME.glow);
		expect(t.glowStrength).toBe(DEFAULT_THEME.glowStrength);
	});

	it('ignores unknown and oversized fields', () => {
		const t = normalizeTheme({ evil: 'x', accent: 'a'.repeat(300) });
		expect(t.accent).toBe(DEFAULT_THEME.accent);
		expect('evil' in t).toBe(false);
	});

	it('inherits split-out colours from the saved theme, not from the default one', () => {
		// The whole point of the fallback: a theme tuned before headings and
		// labels were configurable must keep looking like itself. Filling these
		// from DEFAULT_THEME would give this orange theme Galaxy's blue headings.
		const older = { bg: '#1a1000', accent: '#ff9900', fgDim: '#997755' };
		const t = normalizeTheme(older);
		expect(t.heading).toBe('#ff9900');
		expect(t.galaxyColor).toBe('#ff9900');
		expect(t.label).toBe('#997755');
		expect(t.heading).not.toBe(DEFAULT_THEME.heading);
	});

	it('keeps an explicit heading/label over the inherited one', () => {
		const t = normalizeTheme({ accent: '#ff9900', heading: '#ffffff', label: '#cccccc' });
		expect(t.heading).toBe('#ffffff');
		expect(t.label).toBe('#cccccc');
	});

	it('falls back to the accent when a hostile heading is rejected', () => {
		const t = normalizeTheme({ accent: '#ff9900', heading: 'red}body{display:none' });
		expect(t.heading).toBe('#ff9900');
	});

	it('leaves every preset looking exactly as it did before the split', () => {
		// Each preset's headings were hard-coded to its accent and its labels to
		// its dim text, so those are the only values that preserve appearance.
		for (const [name, p] of Object.entries(PRESETS)) {
			expect(p.heading, name).toBe(p.accent);
			expect(p.galaxyColor, name).toBe(p.accent);
			expect(p.label, name).toBe(p.fgDim);
		}
	});
});

describe('contrastRatio', () => {
	it('gives the WCAG extremes', () => {
		expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
		expect(contrastRatio('#7f9cff', '#7f9cff')).toBe(1);
	});

	it('is symmetric and handles short hex', () => {
		expect(contrastRatio('#fff', '#000')).toBeCloseTo(contrastRatio('#000', '#fff'), 10);
		expect(contrastRatio('#fff', '#ffffff')).toBe(1);
	});

	it('returns 0 for anything it cannot parse, so the editor can say nothing', () => {
		// 0 rather than 1: "no answer" must be distinguishable from "no contrast".
		expect(contrastRatio('var(--accent)', '#000')).toBe(0);
		expect(contrastRatio('rgb(0,0,0)', '#fff')).toBe(0);
		expect(contrastRatio('', '#fff')).toBe(0);
	});

	it('grades against the WCAG thresholds for body text', () => {
		expect(contrastGrade(21)).toBe('AAA');
		expect(contrastGrade(7)).toBe('AAA');
		expect(contrastGrade(4.5)).toBe('AA');
		expect(contrastGrade(3)).toBe('AA-large');
		expect(contrastGrade(2.9)).toBe('fail');
	});
});

describe('themeCss', () => {
	it('exposes the glow as variables and one global hover rule', () => {
		const css = themeCss({ ...DEFAULT_THEME, glow: '#abcdef', glowStrength: '9px' });
		expect(css).toContain('--glow:#abcdef;');
		expect(css).toContain('--glow-size:9px;');
		expect(css).toContain('button:not(:disabled):hover{box-shadow:0 0 var(--glow-size) var(--glow);}');
	});

	it('exposes the split-out text colours and the galaxy colour', () => {
		const css = themeCss({
			...DEFAULT_THEME,
			heading: '#112233',
			label: '#445566',
			galaxyColor: '#778899'
		});
		expect(css).toContain('--heading:#112233;');
		expect(css).toContain('--label:#445566;');
		expect(css).toContain('--galaxy:#778899;');
	});

	it('emits the size as given, so a percentage stacks with browser settings', () => {
		expect(themeCss({ ...DEFAULT_THEME, baseFont: '112%' })).toContain('html{font-size:112%;}');
		// A pixel value from an older theme still renders.
		expect(themeCss({ ...DEFAULT_THEME, baseFont: '15px' })).toContain('html{font-size:15px;}');
	});

	it('keeps the glow transition behind a reduced-motion check', () => {
		// The glow is a state, not motion — but fading into it is.
		expect(themeCss(DEFAULT_THEME)).toContain('@media (prefers-reduced-motion: no-preference)');
	});

	it('cannot be broken out of by a hostile glow value', () => {
		const t = normalizeTheme({ glow: 'red}body{display:none' });
		expect(themeCss(t)).not.toContain('display:none');
	});
});

describe('fonts', () => {
	it('keeps a font id that is in the catalogue', () => {
		const t = normalizeTheme({ fontUi: 'georgia', fontMono: 'consolas' });
		expect(t.fontUi).toBe('georgia');
		expect(t.fontMono).toBe('consolas');
	});

	it('falls back to the default for an id it does not know', () => {
		// The failure mode the catalogue exists to remove: a value that does not
		// name a real font renders the default rather than an unstyled page.
		const t = normalizeTheme({ fontUi: 'comic-sans', fontMono: '' });
		expect(t.fontUi).toBe(DEFAULT_THEME.fontUi);
		expect(t.fontMono).toBe(DEFAULT_THEME.fontMono);
	});

	it('drops a raw CSS stack, which is what themes saved before the split hold', () => {
		// Deliberate: those themes come back on the new defaults rather than
		// carrying a stack that was only ever validated by a character blacklist.
		const t = normalizeTheme({ font: "'SF Mono', ui-monospace, monospace" });
		expect(t.fontUi).toBe(DEFAULT_THEME.fontUi);
		expect(t.fontMono).toBe(DEFAULT_THEME.fontMono);
		expect('font' in t).toBe(false);
	});

	it('emits a variable per role, plus the faces it bundles', () => {
		const css = themeCss(DEFAULT_THEME);
		expect(css).toContain('--font-ui:');
		expect(css).toContain('--font-mono:');
		expect(css).toContain('@font-face');
		expect(css).toContain('/fonts/quicksand-latin.woff2');
	});

	it('gives numbers the monospace font so columns line up', () => {
		expect(themeCss(DEFAULT_THEME)).toContain('.num{font-family:var(--font-mono)');
	});
});

describe('the galaxy backdrop font', () => {
	it('is identical for every preset', () => {
		// It is art made of characters: the shape depends on every glyph being the
		// same width, so it sits outside the theme system entirely.
		for (const [name, preset] of Object.entries(PRESETS)) {
			expect(themeCss(preset), name).toContain(`--font-galaxy:${GALAXY_FONT_STACK}`);
		}
	});

	it('cannot be changed by a theme that tries to set it', () => {
		// The assertion most likely to catch a future refactor quietly wiring the
		// backdrop back into the themeable font.
		const hostile = normalizeTheme({
			...DEFAULT_THEME,
			fontGalaxy: 'Comic Sans MS',
			fontMono: 'courier'
		});
		const css = themeCss(hostile);
		expect(css).toContain(`--font-galaxy:${GALAXY_FONT_STACK}`);
		expect(css).not.toContain('Comic Sans');
	});
});

describe('controlBorder', () => {
	it('clears 3:1 against the page for every preset', () => {
		// WCAG 1.4.11. The plain --border is 1.2:1 in most themes, which is a fine
		// card separator and an invisible text field.
		for (const [name, preset] of Object.entries(PRESETS)) {
			const derived = controlBorder(preset);
			expect(contrastRatio(derived, preset.bg), `${name} (${derived})`).toBeGreaterThanOrEqual(3);
		}
	});

	it('leaves a border alone when it already passes', () => {
		const strong = { ...DEFAULT_THEME, border: '#ffffff' };
		expect(controlBorder(strong)).toBe('#ffffff');
	});

	it('falls back to the text colour rather than an invisible field', () => {
		const broken = { ...DEFAULT_THEME, border: 'not-a-colour' };
		expect(controlBorder(broken)).toBe(broken.fg);
	});

	it('is what the form controls actually get', () => {
		expect(themeCss(DEFAULT_THEME)).toContain(
			'input,select,textarea{border-color:var(--control-border);}'
		);
	});
});

describe('shipped palettes', () => {
	it('clear AA for dim text and field labels on both surfaces', () => {
		// These carry .hint, .meta and .field-hint across the whole app at
		// body-size text, so the large-text allowance does not apply to them.
		for (const [name, preset] of Object.entries(PRESETS)) {
			for (const key of ['fgDim', 'label'] as const) {
				for (const surface of ['bg', 'bgPane'] as const) {
					const ratio = contrastRatio(preset[key], preset[surface]);
					expect(ratio, `${name}.${key} on ${surface} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
				}
			}
		}
	});

	it('clear AA for headings, accent and danger', () => {
		for (const [name, preset] of Object.entries(PRESETS)) {
			for (const key of ['heading', 'accent', 'danger'] as const) {
				const ratio = contrastRatio(preset[key], preset.bgPane);
				expect(ratio, `${name}.${key} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
			}
		}
	});

	it('clear AA for the text on a primary button', () => {
		// Primary buttons put --bg on --accent, which is a pairing nothing else
		// in the editor's contrast grid measures.
		for (const [name, preset] of Object.entries(PRESETS)) {
			const ratio = contrastRatio(preset.bg, preset.accent);
			expect(ratio, `${name} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
		}
	});
});
