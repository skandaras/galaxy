import { describe, it, expect } from 'vitest';
import {
	DEFAULT_THEME,
	PRESETS,
	contrastGrade,
	contrastRatio,
	controlBorder,
	isLight,
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

describe('isLight', () => {
	it('picks out the one light preset', () => {
		// Which way the Cortex map's glow points depends on this, and the answer
		// is only ever "Paper" among what ships. Solar reads light from its name
		// and is not: its background is #0d0a04.
		expect(isLight(PRESETS.Paper.bg)).toBe(true);
		for (const name of ['Galaxy', 'Nebula', 'Solar', 'Void']) {
			expect(isLight(PRESETS[name].bg), name).toBe(false);
		}
	});

	it('puts the line above mid grey, where adding light still means something', () => {
		// Relative luminance is not perceived lightness: #808080 measures 0.216,
		// so a line drawn at "half" would call mid grey light and flip the glow on
		// a page that has plenty of headroom left.
		expect(isLight('#808080')).toBe(false);
		expect(isLight('#cccccc')).toBe(true);
	});

	it('calls anything it cannot read dark, which is what the map assumed before', () => {
		expect(isLight('rgb(255,255,255)')).toBe(false);
		expect(isLight('')).toBe(false);
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

/** Every `--name:value;` the emitted CSS declares, last write winning. */
function tokens(css: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [, name, value] of css.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;}]+)/g)) {
		out[name] = value.trim();
	}
	return out;
}

describe('geometry and stacking tokens', () => {
	it('emits every token the layout composes its chrome from', () => {
		const t = tokens(themeCss(DEFAULT_THEME));
		for (const name of ['--tap', '--strip-h', '--tabbar-h', '--kbd']) {
			expect(t[name], name).toBeDefined();
		}
	});

	it('starts the keyboard inset at zero, so a browser that cannot report it is shut', () => {
		expect(themeCss(DEFAULT_THEME)).toContain('--kbd:0px;');
	});

	it('draws a focus ring, since nine rules used to remove it and put nothing back', () => {
		// :focus-visible rather than :focus, or every mouse click would draw one.
		const css = themeCss(DEFAULT_THEME);
		expect(css).toContain('button:focus-visible');
		expect(css).toContain('outline:2px solid var(--accent)');
		expect(css).not.toContain('button:focus{');
	});

	it('is not themeable, because no setting writes to it', () => {
		// The whole block is fixed text. A theme that tries to reach it should
		// change nothing — same reasoning as the galaxy font above.
		const hostile = normalizeTheme({ accent: '#123456' });
		const a = tokens(themeCss(DEFAULT_THEME));
		const b = tokens(themeCss(hostile));
		for (const name of ['--tap', '--strip-h', '--tabbar-h', '--z-chrome']) {
			expect(b[name], name).toBe(a[name]);
		}
	});

	it('orders the whole stacking ladder strictly ascending', () => {
		// The names exist so the order is readable; this is what keeps the order
		// true. A duplicate or an inversion here is a paint bug nobody sees until
		// a screenshot, so it is cheaper to catch as arithmetic.
		const t = tokens(themeCss(DEFAULT_THEME));
		const ladder = [
			'--z-backdrop',
			'--z-base',
			'--z-drag',
			'--z-drawer',
			'--z-sheet',
			'--z-chrome',
			'--z-modal',
			'--z-scrim',
			'--z-popover'
		];
		const values = ladder.map((name) => {
			expect(t[name], name).toBeDefined();
			return Number(t[name]);
		});
		expect(values.every(Number.isFinite)).toBe(true);
		for (let i = 1; i < values.length; i++) {
			expect(values[i], `${ladder[i]} must sit above ${ladder[i - 1]}`).toBeGreaterThan(
				values[i - 1]
			);
		}
	});

	it('puts chrome above the sheet, which is what un-buries the alerts panel', () => {
		// Not arbitrary: the panel is a descendant of the top strip, so it paints
		// in the strip's stacking context whatever number it carries. This
		// ordering is the fix, and reversing it silently restores the bug.
		const t = tokens(themeCss(DEFAULT_THEME));
		expect(Number(t['--z-chrome'])).toBeGreaterThan(Number(t['--z-sheet']));
		expect(Number(t['--z-chrome'])).toBeGreaterThan(Number(t['--z-drawer']));
	});

	it('puts a full-screen modal above the chrome it covers', () => {
		// The drag ghost belongs under the chrome and a card detail does not, even
		// though both were written as 40. A card below 900px is inset:0 and takes
		// the screen; a tab bar painted over it covers what you opened it to read.
		const t = tokens(themeCss(DEFAULT_THEME));
		expect(Number(t['--z-modal'])).toBeGreaterThan(Number(t['--z-chrome']));
		expect(Number(t['--z-drag'])).toBeLessThan(Number(t['--z-chrome']));
	});
});

describe('the coarse-pointer block', () => {
	/**
	 * The CSS either side of the coarse-pointer block.
	 *
	 * Split rather than read whole, because tokens() keeps the last write of each
	 * name and the override sits later in the same string — so "the default" read
	 * off the full sheet is the override, and a test comparing the two compares a
	 * value with itself. It passed until --tap and its override were both 44.
	 */
	const halves = () => {
		const css = themeCss(DEFAULT_THEME);
		const at = css.indexOf('@media (pointer: coarse)');
		expect(at, 'the coarse-pointer block should be emitted').toBeGreaterThan(-1);
		return { fine: css.slice(0, at), coarse: css.slice(at) };
	};
	const coarse = () => halves().coarse;

	it('raises the sizes rather than lowering them', () => {
		// The rule is that a finger gets more room than a mouse. Written the other
		// way round it would shrink every target on the devices that need them
		// biggest, and still pass a test that only checked the values differ.
		const { fine } = halves();
		const base = tokens(fine);
		const bumped = tokens(coarse());
		for (const name of ['--tap', '--tabbar-h']) {
			expect(parseFloat(bumped[name]), name).toBeGreaterThan(parseFloat(base[name]));
		}
	});

	it('holds a finger to the 44px docs/ACCESSIBILITY.md commits to', () => {
		expect(parseFloat(tokens(coarse())['--tap'])).toBeGreaterThanOrEqual(44);
	});

	it('floors form controls at 16px, or Safari zooms the page on focus', () => {
		// Under 16px iOS scales the whole viewport to the focused field and leaves
		// it there. --text-base is 0.9rem and the Void preset puts html at 94% on
		// top, so almost every control in the app was tripping it.
		expect(coarse()).toContain('input,select,textarea{font-size:max(16px,1em)!important;}');
	});

	it('changes nothing that a narrow window would also change', () => {
		// The dividing line this block exists to hold: capability decides size,
		// width decides layout. A max-width query in here means the two axes have
		// been mixed, which is what gives a narrow desktop window thumb chrome.
		expect(coarse()).not.toContain('max-width');
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
