import { describe, it, expect } from 'vitest';
import { DEFAULT_THEME, normalizeTheme, themeCss } from './theme';

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
			font: 'x; background: url(evil)',
			bg: '#000{',
			radius: '5px\\'
		});
		expect(t.accent).toBe(DEFAULT_THEME.accent);
		expect(t.font).toBe(DEFAULT_THEME.font);
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
});

describe('themeCss', () => {
	it('exposes the glow as variables and one global hover rule', () => {
		const css = themeCss({ ...DEFAULT_THEME, glow: '#abcdef', glowStrength: '9px' });
		expect(css).toContain('--glow:#abcdef;');
		expect(css).toContain('--glow-size:9px;');
		expect(css).toContain('button:not(:disabled):hover{box-shadow:0 0 var(--glow-size) var(--glow);}');
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
