/**
 * The decisions autosave makes, kept out of the page so they can be tested.
 *
 * Nothing in this app autosaved before, so these three questions had no answer
 * anywhere: when to write, when a document that does not exist yet has earned
 * one, and what to call it if nobody said. Same split as `library-tree.ts` —
 * there is no DOM in the test environment, so the judgement comes out of
 * `.svelte` and the page keeps only the timers and the fetches.
 */

/**
 * After typing stops.
 *
 * Short enough that a tab closing costs a sentence rather than a page, long
 * enough that a burst of typing is one write. Each save rewrites the whole
 * markdown file and reindexes it in FTS, so this is not free the way a
 * sessionStorage draft is.
 */
export const AUTOSAVE_IDLE_MS = 1_000;

/**
 * Ceiling during continuous typing.
 *
 * The idle debounce alone never fires for somebody who does not pause, so a
 * long uninterrupted stretch would sit unsaved for as long as they kept going —
 * which is exactly the person with the most to lose.
 */
export const AUTOSAVE_MAX_MS = 10_000;

/**
 * Wait before retrying a failed save, by attempt.
 *
 * Climbing rather than flat, and capped, because the usual cause is a server
 * that has gone away: retrying every second neither helps nor stops.
 */
export const AUTOSAVE_RETRY_MS = [5_000, 15_000, 30_000];

export const retryDelay = (failures: number) =>
	AUTOSAVE_RETRY_MS[Math.min(failures, AUTOSAVE_RETRY_MS.length - 1)];

/** Longest a derived title may be. Past this a shelf row is ellipsis anyway. */
const MAX_DERIVED = 60;

/**
 * Whether a document that does not exist yet has earned one.
 *
 * Title or body, and nothing else. "+ New doc under X" pre-fills a parent, and
 * the folder picker pre-fills a folder — neither may be enough to create a
 * document on its own, or pressing New and walking away would leave an empty
 * shell on the shelf every time. That is the whole reason this is not simply
 * "is any field set".
 */
export function hasContent(title: string, body: string): boolean {
	return title.trim().length > 0 || body.trim().length > 0;
}

/**
 * A title for a document being created with the field left empty.
 *
 * The first line that has words in it, with the markdown that makes it a
 * heading, a bullet or a quote taken off. What Google Docs does, and better than
 * a number because the shelf then reads as what the documents are.
 *
 * Called once, at creation. Re-deriving as the body changed would rename a
 * document under somebody while they were still writing it.
 */
export function deriveTitle(body: string): string {
	for (const raw of body.split('\n')) {
		const line = raw
			// Heading marks, blockquote marks, bullets and ordered-list markers, in
			// whatever order they were nested.
			.replace(/^[\s>]*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)*/, '')
			// Setext underlines and thematic breaks are punctuation, not a title.
			.replace(/^[-=*_\s]+$/, '')
			.trim();
		if (!line) continue;
		return line.length > MAX_DERIVED ? `${line.slice(0, MAX_DERIVED).trimEnd()}…` : line;
	}
	return '';
}

/**
 * The next free "Untitled N", for a body with no usable text in it.
 *
 * Counts what is already there rather than the list's length, so deleting
 * Untitled 2 does not make the next one collide with Untitled 3.
 */
export function untitledName(existing: string[]): string {
	let highest = 0;
	for (const title of existing) {
		const match = /^untitled\s+(\d+)$/i.exec(title.trim());
		if (match) highest = Math.max(highest, Number(match[1]));
	}
	return `Untitled ${highest + 1}`;
}

/** The title a new document is created with, given what the person typed. */
export function titleForNew(typed: string, body: string, existing: string[]): string {
	return typed.trim() || deriveTitle(body) || untitledName(existing);
}
