// Theme definitions shared by server (persistence) and client (editor).

export interface Theme {
	/** Page background */
	bg: string;
	/** Pane/card background */
	bgPane: string;
	/** Foreground text */
	fg: string;
	/** Dimmed text */
	fgDim: string;
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
	/** Root font size — controls overall layout density */
	baseFont: string;
	/** Ambient ASCII galaxy backdrop */
	galaxyBg: boolean;
}

export const PRESETS: Record<string, Theme> = {
	Galaxy: {
		bg: '#05060f',
		bgPane: '#0a0c1a',
		fg: '#c8d0e8',
		fgDim: '#5a627e',
		accent: '#7f9cff',
		border: '#171a2e',
		danger: '#ff5d73',
		font: "'SF Mono', ui-monospace, 'Cascadia Code', Menlo, monospace",
		radius: '5px',
		baseFont: '16px',
		galaxyBg: true
	},
	Nebula: {
		bg: '#0a0512',
		bgPane: '#140a20',
		fg: '#e2d4f0',
		fgDim: '#71618a',
		accent: '#c084fc',
		border: '#241533',
		danger: '#fb7185',
		font: "'SF Mono', ui-monospace, 'Cascadia Code', Menlo, monospace",
		radius: '8px',
		baseFont: '16px',
		galaxyBg: true
	},
	Solar: {
		bg: '#0d0a04',
		bgPane: '#191207',
		fg: '#ede3cf',
		fgDim: '#8a7c5e',
		accent: '#fbbf24',
		border: '#2b2210',
		danger: '#f87171',
		font: "'SF Mono', ui-monospace, 'Cascadia Code', Menlo, monospace",
		radius: '3px',
		baseFont: '16px',
		galaxyBg: true
	},
	Void: {
		bg: '#000000',
		bgPane: '#0a0a0a',
		fg: '#e0e0e0',
		fgDim: '#6a6a6a',
		accent: '#ffffff',
		border: '#1f1f1f',
		danger: '#ff4d4d',
		font: "ui-monospace, 'Cascadia Code', Menlo, monospace",
		radius: '0px',
		baseFont: '15px',
		galaxyBg: false
	},
	Paper: {
		bg: '#f5f2ea',
		bgPane: '#ffffff',
		fg: '#2a2a33',
		fgDim: '#8a8a96',
		accent: '#4c6ef5',
		border: '#dcd8cc',
		danger: '#d6455d',
		font: "'SF Mono', ui-monospace, Menlo, monospace",
		radius: '6px',
		baseFont: '16px',
		galaxyBg: false
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
		`--accent:${t.accent};`,
		`--border:${t.border};`,
		`--danger:${t.danger};`,
		`--font-mono:${t.font};`,
		`--radius:${t.radius};`,
		'}',
		`html{font-size:${t.baseFont};}`
	].join('');
}

/** Keep persisted themes shaped like a Theme even across future field changes. */
export function normalizeTheme(raw: unknown): Theme {
	const r = (raw ?? {}) as Record<string, unknown>;
	const out = { ...DEFAULT_THEME };
	for (const key of Object.keys(DEFAULT_THEME) as (keyof Theme)[]) {
		const v = r[key];
		if (key === 'galaxyBg') {
			if (typeof v === 'boolean') out.galaxyBg = v;
		} else if (typeof v === 'string' && v.length < 200) {
			(out as Record<string, unknown>)[key] = v;
		}
	}
	return out;
}
