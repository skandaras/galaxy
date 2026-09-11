/**
 * Turning a reasoning model's chain-of-thought into one line of status.
 *
 * Chat shows this under the thinking indicator while a model reasons. It is a
 * status line, not a transcript: the point is to answer "what is it doing?"
 * during the half-minute a reasoning model can spend before its first token of
 * answer, not to publish the model's working.
 *
 * Kept out of `loop.ts` so it can be tested directly. The tests are the
 * specification — the shape of chain-of-thought varies wildly by model, and
 * every rule below is here because some model's output broke the line.
 */

/**
 * How often a run may push a new note.
 *
 * Reasoning arrives token by token, and forwarding each one put a chunk on the
 * wire per token for text nobody reads word by word. Slow enough that the line
 * is readable rather than a blur, fast enough to prove the run is alive.
 */
export const REASONING_NOTE_INTERVAL_MS = 900;

/** Longest note worth showing; past this the line wraps and shifts the page. */
export const REASONING_NOTE_MAX = 140;

/**
 * The freshest readable thought in `text`, or '' if there is not one yet.
 *
 * Shows the sentence being written rather than the last one finished, because
 * the finished one can be several seconds stale — and staleness is the exact
 * complaint this is here to answer. A fragment too short to mean anything
 * falls back to the sentence before it, so the line does not flicker down to
 * "So" every time the model starts a new one.
 */
export function reasoningNote(text: string, max = REASONING_NOTE_MAX): string {
	// Markdown headings, list bullets and code fences all show up in
	// chain-of-thought and none of them survive being rendered as plain text —
	// a note that began "### " read as a typo.
	const flat = text
		.replace(/```[\s\S]*?(```|$)/g, ' ')
		.replace(/[#*_>`~]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	if (!flat) return '';
	// Split on sentence ends, keeping the terminator with the sentence it ends.
	// The lookbehind avoids splitting decimals and abbreviations mid-number,
	// which turned "0.4 seconds" into a note reading "4 seconds".
	const parts = flat.split(/(?<=[.!?])\s+(?=[A-Z(\d])/);
	let current = parts.at(-1)?.trim() ?? '';
	if (current.length < 12 && parts.length > 1) current = parts.at(-2)?.trim() ?? current;
	if (current.length <= max) return current;
	const cut = current.slice(0, max);
	const space = cut.lastIndexOf(' ');
	// Only break on a word if the break is near the end; a sentence whose first
	// word is longer than the cap would otherwise render as a lone ellipsis.
	return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * A throttled sink for a reasoning model's chain-of-thought.
 *
 * Every caller that surfaces reasoning wants the same four things — keep a
 * tail, cap it, rate-limit the notes, and drop the ones too short to mean
 * anything — and the agent loop and the research pipeline had no business
 * each owning a copy of that. Returns the feed to hand deltas to.
 *
 * Build one per model call, not per run: the buffer is that call's thought,
 * and carrying it across a leg showed a note about work that had already
 * finished.
 *
 * A missing `onNote` yields a sink that does nothing, so a caller with
 * nowhere to send notes — research runs `frameQuestion` and friends directly
 * from tests, with no job — needs no branch of its own.
 */
export function reasoningNotes(
	onNote?: (text: string) => void
): (delta: string) => void {
	if (!onNote) return () => {};
	let buffer = '';
	let notedAt = 0;
	return (delta: string) => {
		buffer += delta;
		// Only the tail is ever read, and a long think is tens of kilobytes of it.
		if (buffer.length > REASONING_BUFFER_MAX) {
			buffer = buffer.slice(-REASONING_BUFFER_KEEP);
		}
		const now = Date.now();
		if (now - notedAt < REASONING_NOTE_INTERVAL_MS) return;
		// Cheap gate before the expensive one, and before anything is spent: the
		// first token of a call is a word or two, which cannot make a note.
		if (buffer.length < REASONING_NOTE_MIN) return;
		const note = reasoningNote(buffer);
		// Under a dozen characters a note is a fragment — "So", "The user" — and
		// the line reads as flicker rather than as progress.
		if (note.length < REASONING_NOTE_MIN) return;
		// Only a note that went out closes the window. Closing it on an attempt
		// instead meant the first fragment of a call — too short to say anything
		// — spent the whole interval, and the status line sat empty for a second
		// after the model had already started thinking.
		notedAt = now;
		onNote(note);
	};
}

/** Where the tail is trimmed, and back to what, so trimming is not per-token. */
const REASONING_BUFFER_MAX = 2400;
const REASONING_BUFFER_KEEP = 2000;

/** Shortest note worth showing — see the note in `reasoningNotes`. */
const REASONING_NOTE_MIN = 12;
