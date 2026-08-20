/**
 * The fonts Galaxy offers, and the only place a font stack is ever written.
 *
 * Choosing a font used to mean typing a raw CSS font-family list into a text
 * box, which broke constantly and for a structural reason: nothing required a
 * generic family at the end, so a single typo or one uninstalled face dropped
 * the whole interface to the browser's default serif with no indication why.
 *
 * A theme now stores an **id from this list** rather than free text. Every stack
 * below ends in a generic, so a stack without a fallback has become
 * unrepresentable — which is the actual repair. It also means the value can be
 * validated exactly (`isFontId`) instead of being pattern-matched for anything
 * that might break out of a CSS declaration.
 */

export type FontRole = 'ui' | 'mono';

export interface FontOption {
	/** Stable key. This is what a theme stores, and what must never change. */
	id: string;
	label: string;
	/** The full CSS list. Always ends in a generic family — see FALLBACK_OF. */
	stack: string;
	role: FontRole;
	/**
	 * We ship the file, so it renders on every machine and the availability
	 * probe is skipped for it.
	 */
	bundled?: boolean;
	/** The family the probe looks for; absent when there is nothing to check. */
	probe?: string;
}

/**
 * Interface faces. Every monospace option is offered here too (see
 * `optionsFor`): Galaxy's entire interface is monospace today, and that has to
 * stay a choice someone can keep rather than something this change takes away.
 */
const UI_FONTS: FontOption[] = [
	{
		id: 'quicksand',
		label: 'Quicksand',
		stack: "'Quicksand', system-ui, -apple-system, 'Segoe UI', sans-serif",
		role: 'ui',
		bundled: true
	},
	{
		id: 'system-ui',
		label: 'System default',
		stack: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
		role: 'ui'
	},
	{
		id: 'inter',
		label: 'Inter',
		stack: "'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif",
		role: 'ui',
		probe: 'Inter'
	},
	{
		id: 'helvetica',
		label: 'Helvetica / Arial',
		stack: "'Helvetica Neue', Helvetica, Arial, sans-serif",
		role: 'ui',
		probe: 'Helvetica Neue'
	},
	{
		id: 'georgia',
		label: 'Georgia',
		stack: "Georgia, 'Times New Roman', serif",
		role: 'ui',
		probe: 'Georgia'
	},
	{
		id: 'charter',
		label: 'Charter / serif',
		stack: "Charter, 'Bitstream Charter', 'Iowan Old Style', Georgia, serif",
		role: 'ui',
		probe: 'Charter'
	}
];

const MONO_FONTS: FontOption[] = [
	{
		id: 'source-code-pro',
		label: 'Source Code Pro',
		stack: "'Source Code Pro', ui-monospace, Menlo, Consolas, monospace",
		role: 'mono',
		bundled: true
	},
	{
		id: 'system-mono',
		label: 'System default',
		stack: "'SF Mono', ui-monospace, 'Cascadia Code', Menlo, Consolas, monospace",
		role: 'mono'
	},
	{
		id: 'jetbrains-mono',
		label: 'JetBrains Mono',
		stack: "'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace",
		role: 'mono',
		probe: 'JetBrains Mono'
	},
	{
		id: 'fira-code',
		label: 'Fira Code',
		stack: "'Fira Code', 'Fira Mono', ui-monospace, Menlo, Consolas, monospace",
		role: 'mono',
		probe: 'Fira Code'
	},
	{
		id: 'cascadia',
		label: 'Cascadia Code',
		stack: "'Cascadia Code', 'Cascadia Mono', ui-monospace, Consolas, monospace",
		role: 'mono',
		probe: 'Cascadia Code'
	},
	{
		id: 'consolas',
		label: 'Consolas',
		stack: "Consolas, 'Lucida Console', ui-monospace, monospace",
		role: 'mono',
		probe: 'Consolas'
	},
	{
		id: 'menlo',
		label: 'Menlo / Monaco',
		stack: "Menlo, Monaco, ui-monospace, monospace",
		role: 'mono',
		probe: 'Menlo'
	},
	{
		id: 'courier',
		label: 'Courier',
		stack: "'Courier New', Courier, monospace",
		role: 'mono',
		probe: 'Courier New'
	}
];

export const FONTS: FontOption[] = [...UI_FONTS, ...MONO_FONTS];

const BY_ID = new Map(FONTS.map((f) => [f.id, f]));

export const DEFAULT_UI_FONT = 'quicksand';
export const DEFAULT_MONO_FONT = 'source-code-pro';

/**
 * The generic every stack must end in, per role. Asserted in the tests: this is
 * the invariant the old free-text box could not hold, and the whole reason the
 * catalogue exists.
 */
export const GENERIC_FAMILIES = ['sans-serif', 'serif', 'monospace'] as const;

export function isFontId(value: unknown): value is string {
	return typeof value === 'string' && BY_ID.has(value);
}

export function getFont(id: string): FontOption | undefined {
	return BY_ID.get(id);
}

/**
 * Resolve an id to its stack, falling back to the role's default rather than
 * returning nothing. A corrupt, hand-edited or since-removed id renders the
 * default face instead of an unstyled page.
 */
export function fontStack(id: string | undefined, role: FontRole): string {
	const found = id ? BY_ID.get(id) : undefined;
	if (found) return found.stack;
	return BY_ID.get(role === 'ui' ? DEFAULT_UI_FONT : DEFAULT_MONO_FONT)!.stack;
}

/**
 * What a role's dropdown offers. The UI list carries every monospace face after
 * its own, because an all-monospace interface is what Galaxy looks like today.
 */
export function optionsFor(role: FontRole): FontOption[] {
	return role === 'ui' ? [...UI_FONTS, ...MONO_FONTS] : MONO_FONTS;
}

/**
 * The backdrop's font, which is deliberately **not** in the catalogue and not
 * settable from anywhere.
 *
 * The ASCII galaxy is art made of characters: its shape depends on every glyph
 * being the same width. Leaving it on the themeable code font would mean a
 * dropdown could distort the spiral — a regression invisible in a diff and easy
 * to blame on something else. This is exactly the stack it rendered in before
 * fonts became configurable, with the bundled Source Code Pro appended so a
 * machine with none of the system monospaces still gets a real one rather than
 * whatever the browser calls `monospace`.
 */
export const GALAXY_FONT_STACK =
	"'SF Mono', ui-monospace, 'Cascadia Code', Menlo, 'Source Code Pro', monospace";

/**
 * `@font-face` for the two faces we ship. Both are variable, so one file covers
 * the weight range; `swap` means text is readable immediately rather than
 * invisible while the file loads.
 */
export const FONT_FACE_CSS = [
	"@font-face{font-family:'Quicksand';src:url('/fonts/quicksand-latin.woff2') format('woff2');font-weight:400 700;font-style:normal;font-display:swap;}",
	"@font-face{font-family:'Source Code Pro';src:url('/fonts/source-code-pro-latin.woff2') format('woff2');font-weight:400 700;font-style:normal;font-display:swap;}"
].join('');
