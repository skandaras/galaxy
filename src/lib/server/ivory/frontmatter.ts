/**
 * Frontmatter for the Shelf's briefs, notes and claims.
 *
 * `skills.ts` has a frontmatter reader already, but it keeps every value as the
 * raw rest of the line: `disciplines: [a, b]  # comment` would come back as that
 * whole string. The Shelf templates use flow lists, quoted strings and trailing
 * comments on almost every line, so they need this slightly larger subset.
 * Still a subset, and on purpose: there is no YAML package here, the dependency
 * list is kept short, and a brief that needs anchors or nested maps has stopped
 * being a brief.
 */

export type FmValue = string | number | boolean | null | FmValue[];

export interface Frontmatter {
	meta: Record<string, FmValue>;
	body: string;
	/** False when the text had no frontmatter block at all. */
	present: boolean;
}

const BLOCK = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/;

export function parseFrontmatter(raw: string): Frontmatter {
	const m = BLOCK.exec(raw.replace(/^\uFEFF/, ''));
	if (!m) return { meta: {}, body: raw, present: false };
	const meta: Record<string, FmValue> = {};
	const lines = m[1].split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const kv = /^([\w-]+):(.*)$/.exec(lines[i]);
		if (!kv) continue;
		const rest = stripComment(kv[2]).trim();
		if (rest) {
			meta[kv[1]] = scalarOrList(rest);
			continue;
		}
		// A block list: "key:" followed by indented "- item" lines.
		const items: FmValue[] = [];
		while (i + 1 < lines.length && /^\s+-\s*/.test(lines[i + 1])) {
			i++;
			items.push(scalar(stripComment(lines[i].replace(/^\s+-\s*/, '')).trim()));
		}
		meta[kv[1]] = items.length ? items : null;
	}
	return { meta, body: m[2], present: true };
}

/** Drop a `# comment`, but not a `#` inside quotes or glued to a word (`C#`, a URL fragment). */
function stripComment(s: string): string {
	let quote: string | null = null;
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (quote) {
			if (c === '\\' && quote === '"') i++;
			else if (c === quote) quote = null;
		} else if (c === '"' || c === "'") {
			quote = c;
		} else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) {
			return s.slice(0, i);
		}
	}
	return s;
}

function scalarOrList(s: string): FmValue {
	if (s.startsWith('[') && s.endsWith(']')) {
		const inner = s.slice(1, -1).trim();
		return inner ? splitList(inner).map((x) => scalar(x.trim())) : [];
	}
	return scalar(s);
}

function splitList(s: string): string[] {
	const out: string[] = [];
	let quote: string | null = null;
	let start = 0;
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (quote) {
			if (c === '\\' && quote === '"') i++;
			else if (c === quote) quote = null;
		} else if (c === '"' || c === "'") {
			quote = c;
		} else if (c === ',') {
			out.push(s.slice(start, i));
			start = i + 1;
		}
	}
	out.push(s.slice(start));
	return out.filter((x) => x.trim() !== '');
}

function scalar(s: string): FmValue {
	if (s === '' || s === '~' || s === 'null') return null;
	if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
		return s.slice(1, -1).replace(/\\(["\\])/g, '$1');
	}
	if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) {
		return s.slice(1, -1).replace(/''/g, "'");
	}
	if (s === 'true') return true;
	if (s === 'false') return false;
	if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
	return s;
}

export function fmString(v: FmValue | undefined): string {
	if (v === null || v === undefined || Array.isArray(v)) return '';
	return String(v).trim();
}

export function fmList(v: FmValue | undefined): string[] {
	if (Array.isArray(v)) return v.map((x) => fmString(x)).filter(Boolean);
	const one = fmString(v);
	return one ? [one] : [];
}

/**
 * Set top-level fields, replacing the whole line where the key exists and
 * appending before the closing fence where it does not.
 *
 * For the fields the platform knows better than the model does (which project,
 * which run, which issue): what an agent wrote there is overwritten rather than
 * trusted.
 */
export function setFrontmatterFields(raw: string, fields: Record<string, string>): string {
	const m = BLOCK.exec(raw);
	const render = (k: string, v: string) => `${k}: ${JSON.stringify(v)}`;
	if (!m) {
		const head = Object.entries(fields).map(([k, v]) => render(k, v));
		return ['---', ...head, '---', raw].join('\n');
	}
	const lines = m[1].split(/\r?\n/);
	const pending = new Map(Object.entries(fields));
	for (let i = 0; i < lines.length; i++) {
		const kv = /^([\w-]+):/.exec(lines[i]);
		if (kv && pending.has(kv[1])) {
			lines[i] = render(kv[1], pending.get(kv[1])!);
			pending.delete(kv[1]);
			// A block list under the old value would otherwise be left hanging.
			while (i + 1 < lines.length && /^\s+-/.test(lines[i + 1])) lines.splice(i + 1, 1);
		}
	}
	for (const [k, v] of pending) lines.push(render(k, v));
	return ['---', ...lines, '---', m[2]].join('\n');
}
