import { fmList, fmString, parseFrontmatter } from './frontmatter';

/**
 * What a source note must hold before it may be written to the Shelf.
 *
 * Checked in code, at the write, rather than asked for in the prompt. A note
 * is what every later claim cites, and "no quote, no claim" is only a rule if
 * a note that breaks it never lands. The reader gets the list of problems back
 * as the tool's error and fixes the note, which a small model does readily
 * once it is told exactly what is missing.
 */

/**
 * The skill holding the note method. The reader's prompt carries its body by
 * name, so the seed and the run both read the name from here.
 */
export const WRITE_SOURCE_NOTE_SKILL = 'write-source-note';

export const NOTE_ACCESS = ['full-text', 'abstract-only'] as const;

export interface NoteClaim {
	heading: string;
	claim: string;
	quote: string;
	location: string;
}

export interface ParsedNote {
	id: string;
	access: string;
	claims: NoteClaim[];
}

/** The `### …` entries under "## Claims extracted", each with its bullet fields. */
export function noteClaims(body: string): NoteClaim[] {
	const section = /^##\s+Claims extracted\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/m.exec(body)?.[1] ?? '';
	const clean = section.replace(/<!--[\s\S]*?-->/g, '');
	const out: NoteClaim[] = [];
	for (const part of clean.split(/^###\s+/m).slice(1)) {
		const [heading, ...rest] = part.split('\n');
		const text = rest.join('\n');
		const field = (name: string) =>
			// [ \t] rather than \s: an empty field must not borrow the next line.
			new RegExp(`^[ \\t]*-[ \\t]*${name}[ \\t]*:[ \\t]*(.*)$`, 'im').exec(text)?.[1].trim() ?? '';
		out.push({
			heading: heading.trim(),
			claim: field('Claim'),
			quote: unquote(field('Quote')),
			location: field('Location')
		});
	}
	return out;
}

function unquote(s: string): string {
	return s.replace(/^["“'‘]+|["”'’]+$/g, '').trim();
}

/** Every problem with a note, or none. The fields Galaxy stamps are checked too. */
export function validateNote(text: string, expect: { project: string }): string[] {
	const problems: string[] = [];
	const { meta, body, present } = parseFrontmatter(text);
	if (!present) return ['The note has no frontmatter. Start from the note template.'];

	const id = fmString(meta.id);
	if (!/^N-\d{3,}$/.test(id)) problems.push('`id` must look like N-001.');
	if (fmString(meta.project) !== expect.project) problems.push(`\`project\` must be ${expect.project}.`);
	if (!fmString(meta.title)) problems.push('`title` must name the source.');
	if (!fmList(meta.authors).length) problems.push('`authors` must list at least one author (use an organisation if there is no person).');
	if (meta.year !== null && meta.year !== undefined && !(typeof meta.year === 'number' && meta.year > 1000 && meta.year < 3000)) {
		problems.push('`year` must be a four-digit year, or left empty when unknown.');
	}
	if (!fmString(meta.doi_or_url)) problems.push('`doi_or_url` must say where the source is.');
	const access = fmString(meta.access);
	if (!(NOTE_ACCESS as readonly string[]).includes(access)) {
		problems.push('`access` must be full-text or abstract-only.');
	}
	if (!fmString(meta.read_by)) problems.push('`read_by` is missing.');
	if (!fmString(meta.task)) problems.push('`task` is missing.');

	if (!/^##\s+Summary\s*$/m.test(body)) problems.push('The note needs a "## Summary" section.');
	if (!/^##\s+Claims extracted\s*$/m.test(body)) problems.push('The note needs a "## Claims extracted" section.');
	for (const c of noteClaims(body)) {
		const name = c.heading || '(unnamed claim)';
		if (id && !c.heading.startsWith(`${id}.`)) problems.push(`Claim "${name}" should be numbered ${id}.1, ${id}.2 and so on.`);
		if (!c.claim) problems.push(`Claim "${name}" has no "- Claim:" line.`);
		if (!c.quote) problems.push(`Claim "${name}" has no quote. No quote, no claim: add a short verbatim quote or remove the claim.`);
		if (!c.location) problems.push(`Claim "${name}" has no location (section, page or figure).`);
	}
	return problems;
}

export function parseNote(text: string): ParsedNote {
	const { meta, body } = parseFrontmatter(text);
	return { id: fmString(meta.id), access: fmString(meta.access), claims: noteClaims(body) };
}

/**
 * Lowercase letters and digits only, single-spaced: what survives PDF
 * extraction, curly quotes, hyphenation at a line end and HTML entities alike.
 */
export function comparable(s: string): string {
	return s
		.normalize('NFKD')
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, ' ')
		.trim();
}
