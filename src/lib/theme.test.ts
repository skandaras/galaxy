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

	it('ignores unknown and oversized fields', () => {
		const t = normalizeTheme({ evil: 'x', accent: 'a'.repeat(300) });
		expect(t.accent).toBe(DEFAULT_THEME.accent);
		expect('evil' in t).toBe(false);
	});
});
