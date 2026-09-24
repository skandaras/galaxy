import { fmList, fmString, parseFrontmatter } from './frontmatter';

/**
 * Mapping claims: what the synthesiser writes and the red-team attacks.
 *
 * The brief leaves the claim gates (what a claim needs before it leaves draft,
 * or may be called survived) as instructions for now, so what is checked here
 * is structure only: the fields a claim must carry, the template's sections,
 * and notes that exist. The one rule enforced in code is the one the brief
 * names as checked at run time: a claim is never reviewed by a model from the
 * same family as the one that wrote it. See modelFamily.
 */

export const CLAIM_STATUSES = ['draft', 'challenged', 'survived', 'known', 'refuted'] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

export const CLAIM_SECTIONS = [
	'Claim',
	'Formalism in the source domain',
	'Mapping',
	'Assumptions carried over',
	'Predictions',
	'Prior art in the target field',
	'Red-team log',
	'Verdict'
];

export interface ParsedClaim {
	id: string;
	status: string;
	authoredBy: string;
	reviewedBy: string[];
	notes: string[];
	title: string;
}

export function parseClaim(text: string): ParsedClaim {
	const { meta, body } = parseFrontmatter(text);
	return {
		id: fmString(meta.id),
		status: fmString(meta.status),
		authoredBy: fmString(meta.authored_by),
		reviewedBy: fmList(meta.reviewed_by),
		notes: fmList(meta.notes),
		title: /^#\s+(.+)$/m.exec(body)?.[1].trim() ?? ''
	};
}

/** A note reference as a bare file name: `notes/N-001-x.md`, `N-001-x.md` and `N-001-x` all become `N-001-x.md`. */
export function noteFileName(ref: string): string {
	const name = ref.trim().split('/').pop() ?? '';
	return name.endsWith('.md') ? name : `${name}.md`;
}

/** Every structural problem with a claim, or none. */
export function validateClaim(text: string, expect: { project: string; notesOnShelf: string[] }): string[] {
	const { meta, body, present } = parseFrontmatter(text);
	if (!present) return ['The claim has no frontmatter. Start from the claim template.'];
	const problems: string[] = [];
	if (!/^C-\d{3,}$/.test(fmString(meta.id))) problems.push('`id` must look like C-001.');
	if (fmString(meta.type) !== 'mapping') problems.push('`type` must be mapping.');
	if (fmString(meta.project) !== expect.project) problems.push(`\`project\` must be ${expect.project}.`);
	if (!(CLAIM_STATUSES as readonly string[]).includes(fmString(meta.status))) {
		problems.push(`\`status\` must be one of ${CLAIM_STATUSES.join(', ')}.`);
	}
	if (!fmString(meta.source_domain)) problems.push('`source_domain` must say where the mechanism is established.');
	if (!fmString(meta.target_domain)) problems.push('`target_domain` must say where it is proposed to apply.');
	const cited = fmList(meta.notes);
	if (!cited.length) problems.push('`notes` must list the notes/ files the claim relies on.');
	const onShelf = new Set(expect.notesOnShelf.map(noteFileName));
	for (const n of cited) {
		if (!onShelf.has(noteFileName(n))) problems.push(`\`notes\` cites ${n}, which is not in this project's notes/.`);
	}
	for (const s of CLAIM_SECTIONS) {
		if (!new RegExp(`^##\\s+${s}\\s*$`, 'mi').test(body)) problems.push(`The "## ${s}" section is missing.`);
	}
	return problems;
}

/**
 * Model makers whose models are served under their own names, for keys that
 * carry no vendor prefix (a direct provider's `claude-…` rather than
 * OpenRouter's `anthropic/claude-…`). Without this the same model reached two
 * ways would count as two families.
 */
const FAMILY_ALIASES: [RegExp, string][] = [
	[/^claude/, 'anthropic'],
	[/^(gpt|o1|o3|o4|chatgpt)/, 'openai'],
	[/^(gemini|gemma)/, 'google'],
	[/^(llama|meta-llama)/, 'meta-llama'],
	[/^(glm|chatglm)/, 'z-ai'],
	[/^qwen/, 'qwen'],
	[/^(mistral|mixtral|codestral|ministral)/, 'mistralai'],
	[/^deepseek/, 'deepseek'],
	[/^grok/, 'x-ai'],
	[/^(kimi|moonshot)/, 'moonshotai']
];

/**
 * Who made a model, from its key: the vendor segment where there is one
 * (`z-ai/glm-5.3`, `~openai/gpt-luna-latest`), otherwise the maker a bare
 * name belongs to. Vendor segments are normalised through the same table, so
 * `anthropic/…` and a bare `claude-…` agree.
 */
export function modelFamily(modelKey: string): string {
	const key = modelKey.trim().toLowerCase().replace(/^~/, '');
	const slash = key.indexOf('/');
	const vendor = slash > 0 ? key.slice(0, slash) : '';
	const name = slash > 0 ? key.slice(slash + 1) : key;
	for (const [re, family] of FAMILY_ALIASES) if (re.test(name)) return family;
	return vendor || name.split(/[-_.:]/)[0];
}

/** The family of the model named in `authored_by` (`task + modelKey`), or null for a person. */
export function authoredFamily(authoredBy: string): string | null {
	const m = /\+\s*(\S+)\s*$/.exec(authoredBy);
	return m ? modelFamily(m[1]) : null;
}
