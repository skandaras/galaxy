import { describe, expect, it } from 'vitest';
import {
	DEFAULT_MONO_FONT,
	DEFAULT_UI_FONT,
	FONTS,
	FONT_FACE_CSS,
	GALAXY_FONT_STACK,
	GENERIC_FAMILIES,
	fontStack,
	getFont,
	isFontId,
	optionsFor
} from './fonts';

describe('the catalogue', () => {
	it('ends every stack in a generic family', () => {
		// The invariant the free-text box could not hold, and the reason this
		// module exists: a stack without a fallback is now unrepresentable, so a
		// missing font can never drop the interface to an unstyled default.
		for (const font of FONTS) {
			const last = font.stack.split(',').pop()!.trim();
			expect(
				GENERIC_FAMILIES,
				`${font.id} ends in "${last}", which is not a generic family`
			).toContain(last);
		}
	});

	it('gives every option a unique id', () => {
		const ids = FONTS.map((f) => f.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('quotes every family name containing a space', () => {
		for (const font of FONTS) {
			for (const part of font.stack.split(',').map((p) => p.trim())) {
				if (!part.includes(' ') || part.startsWith("'")) continue;
				// ui-monospace and system-ui are keywords, not family names.
				expect(part, `${font.id}: "${part}" needs quoting`).not.toMatch(/^[A-Z]/);
			}
		}
	});

	it('ships the two defaults rather than hoping they are installed', () => {
		expect(getFont(DEFAULT_UI_FONT)?.bundled).toBe(true);
		expect(getFont(DEFAULT_MONO_FONT)?.bundled).toBe(true);
	});

	it('never probes for a font it bundles', () => {
		for (const font of FONTS.filter((f) => f.bundled)) {
			expect(font.probe).toBeUndefined();
		}
	});
});

describe('isFontId', () => {
	it('accepts a known id and rejects everything else', () => {
		expect(isFontId('quicksand')).toBe(true);
		expect(isFontId('not-a-font')).toBe(false);
		expect(isFontId('')).toBe(false);
		expect(isFontId(undefined)).toBe(false);
		expect(isFontId(42)).toBe(false);
		// A raw stack is exactly what people used to type, and is now invalid.
		expect(isFontId("'SF Mono', monospace")).toBe(false);
	});
});

describe('fontStack', () => {
	it('resolves a known id', () => {
		expect(fontStack('georgia', 'ui')).toContain('Georgia');
	});

	it('falls back to the role default rather than returning nothing', () => {
		// A hand-edited setting, or an id removed in a later release, must render
		// the default face — not an unstyled page.
		expect(fontStack('gone', 'ui')).toBe(fontStack(DEFAULT_UI_FONT, 'ui'));
		expect(fontStack(undefined, 'mono')).toBe(fontStack(DEFAULT_MONO_FONT, 'mono'));
		expect(fontStack('', 'mono')).toContain('Source Code Pro');
	});

	it('falls back per role, not to one global default', () => {
		expect(fontStack('gone', 'mono')).not.toBe(fontStack('gone', 'ui'));
	});
});

describe('optionsFor', () => {
	it('offers monospace faces in the interface list too', () => {
		// Galaxy's whole interface is monospace today; this change must not take
		// that away from anyone who wants to keep it.
		const ui = optionsFor('ui').map((f) => f.id);
		expect(ui).toContain('quicksand');
		expect(ui).toContain('source-code-pro');
	});

	it('offers only monospace faces for code', () => {
		expect(optionsFor('mono').every((f) => f.role === 'mono')).toBe(true);
	});

	it('leads each list with the shipped default', () => {
		expect(optionsFor('ui')[0].id).toBe(DEFAULT_UI_FONT);
		expect(optionsFor('mono')[0].id).toBe(DEFAULT_MONO_FONT);
	});
});

describe('the galaxy backdrop font', () => {
	it('is not something the catalogue can select', () => {
		// It is deliberately outside the theme system: no dropdown writes to it,
		// so no font choice can distort the ASCII art.
		expect(FONTS.some((f) => f.stack === GALAXY_FONT_STACK)).toBe(false);
	});

	it('ends in a generic and names a bundled font before it', () => {
		expect(GALAXY_FONT_STACK.endsWith('monospace')).toBe(true);
		// The point of the bundled fallback: a machine with none of the system
		// monospaces still renders the art in a real fixed-width face.
		expect(GALAXY_FONT_STACK).toContain('Source Code Pro');
	});
});

describe('FONT_FACE_CSS', () => {
	it('declares both bundled faces against files we actually ship', () => {
		expect(FONT_FACE_CSS).toContain('/fonts/quicksand-latin.woff2');
		expect(FONT_FACE_CSS).toContain('/fonts/source-code-pro-latin.woff2');
	});

	it('covers the variable weight range and swaps rather than hiding text', () => {
		expect(FONT_FACE_CSS).toContain('font-weight:400 700');
		expect(FONT_FACE_CSS.match(/font-display:swap/g)).toHaveLength(2);
	});
});
