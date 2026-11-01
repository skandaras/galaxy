/**
 * What a proposed change to a skill is, and how it applies.
 *
 * Shared by the server, which checks and applies a change, and the Profile page,
 * which draws it for the person deciding. One definition, because a diff that
 * shows one thing and an apply that does another is the failure a review step
 * exists to stop.
 *
 * Modelled on Hermes Agent's `skill_manage patch`: exact old and new strings
 * rather than a rewritten body, so a change touches what it names and a skill
 * is never quietly reworded around it.
 */

export interface SkillEdit {
	old: string;
	new: string;
}

export interface SkillPatch {
	edits: SkillEdit[];
	/** A replacement one-line description, when the change needs one. */
	description?: string;
	/** Replacement triggers, likewise. */
	triggers?: string;
}

export const MAX_SKILL_EDITS = 8;
export const MAX_SKILL_BODY_CHARS = 20_000;

/**
 * The edits a call or a reply carried, in either spelling (`old_string` and
 * `new_string`, as the tool takes them, or `old` and `new`), or what is wrong.
 * A JSON string of the array is accepted too: some models encode it twice.
 */
export function readEdits(raw: unknown): SkillEdit[] | { problem: string } {
	let value = raw;
	if (typeof value === 'string') {
		try {
			value = JSON.parse(value);
		} catch {
			return { problem: 'edits must be a list of {old_string, new_string}.' };
		}
	}
	if (!Array.isArray(value) || !value.length) {
		return { problem: 'edits must be a non-empty list of {old_string, new_string}.' };
	}
	if (value.length > MAX_SKILL_EDITS) {
		return { problem: `At most ${MAX_SKILL_EDITS} edits in one change.` };
	}
	const out: SkillEdit[] = [];
	for (const [i, item] of value.entries()) {
		const e = (item ?? {}) as Record<string, unknown>;
		const old = e.old_string ?? e.old;
		const replacement = e.new_string ?? e.new;
		if (typeof old !== 'string' || typeof replacement !== 'string') {
			return { problem: `edit ${i + 1}: needs old_string and new_string, both text.` };
		}
		out.push({ old, new: replacement });
	}
	return out;
}

/** Non-overlapping is not enough: "aa" occurs twice in "aaa". */
function occurrences(text: string, needle: string): number {
	let count = 0;
	for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) count++;
	return count;
}

/**
 * Apply edits in order, each to the text the one before it left.
 *
 * Every `old` has to occur exactly once, so an edit can never land somewhere
 * other than where its author was looking. Replacement is by slicing, never
 * `String.replace`, which reads `$&` and `$1` inside the new text as patterns.
 */
export function applySkillPatch(
	body: string,
	edits: SkillEdit[]
): { ok: true; body: string } | { ok: false; problem: string } {
	let text = body;
	for (const [i, edit] of edits.entries()) {
		const n = i + 1;
		if (!edit.old) return { ok: false, problem: `edit ${n}: the old text is empty.` };
		if (edit.old === edit.new) return { ok: false, problem: `edit ${n}: the new text is the same as the old.` };
		const found = occurrences(text, edit.old);
		if (found === 0) {
			return { ok: false, problem: `edit ${n}: the old text is not in the skill. Copy it exactly from what skill_load returned.` };
		}
		if (found > 1) {
			return {
				ok: false,
				problem: `edit ${n}: the old text appears ${found} times; include more of the surrounding lines so it names one place.`
			};
		}
		const at = text.indexOf(edit.old);
		text = text.slice(0, at) + edit.new + text.slice(at + edit.old.length);
	}
	if (!text.trim()) return { ok: false, problem: 'The change would leave the skill empty.' };
	if (text.length > MAX_SKILL_BODY_CHARS) {
		return { ok: false, problem: `The change would make the skill ${text.length} characters; the limit is ${MAX_SKILL_BODY_CHARS}.` };
	}
	return { ok: true, body: text };
}

export type DiffLine =
	| { kind: 'same' | 'add' | 'del'; text: string }
	/** Unchanged lines left out of the view, by count. */
	| { kind: 'gap'; count: number };

/** Lines past which a diff is drawn as replace-all rather than computed. */
const MAX_DIFF_LINES = 800;

/**
 * A line diff for a person to read: what goes, what comes, and `context`
 * unchanged lines either side of each change, with longer unchanged runs
 * folded into a gap.
 */
export function lineDiff(before: string, after: string, context = 2): DiffLine[] {
	const a = before.split('\n');
	const b = after.split('\n');
	const full: DiffLine[] = [];
	if (a.length + b.length > MAX_DIFF_LINES * 2) {
		for (const text of a) full.push({ kind: 'del', text });
		for (const text of b) full.push({ kind: 'add', text });
	} else {
		// Longest common subsequence, then a walk back through it.
		const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
		for (let i = a.length - 1; i >= 0; i--) {
			for (let j = b.length - 1; j >= 0; j--) {
				lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
			}
		}
		let i = 0;
		let j = 0;
		while (i < a.length && j < b.length) {
			if (a[i] === b[j]) {
				full.push({ kind: 'same', text: a[i] });
				i++;
				j++;
			} else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
				full.push({ kind: 'del', text: a[i++] });
			} else {
				full.push({ kind: 'add', text: b[j++] });
			}
		}
		while (i < a.length) full.push({ kind: 'del', text: a[i++] });
		while (j < b.length) full.push({ kind: 'add', text: b[j++] });
	}

	const near = full.map((line, k) =>
		line.kind !== 'same'
			? true
			: full.slice(Math.max(0, k - context), k + context + 1).some((l) => l.kind !== 'same')
	);
	const out: DiffLine[] = [];
	for (const [k, line] of full.entries()) {
		if (near[k]) {
			out.push(line);
			continue;
		}
		const last = out.at(-1);
		if (last?.kind === 'gap') last.count++;
		else out.push({ kind: 'gap', count: 1 });
	}
	return out;
}
