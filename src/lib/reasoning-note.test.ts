import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
	REASONING_NOTE_INTERVAL_MS,
	REASONING_NOTE_MAX,
	reasoningNote,
	reasoningNotes
} from './reasoning-note';

describe('reasoningNote', () => {
	it('has nothing to say before the model does', () => {
		expect(reasoningNote('')).toBe('');
		expect(reasoningNote('   \n\t ')).toBe('');
	});

	it('shows the sentence being written, not the last one finished', () => {
		// The finished sentence can be seconds stale, and staleness is the exact
		// complaint the line exists to answer.
		const text = 'First I should check the docs. Now I am looking at the routing table';
		expect(reasoningNote(text)).toBe('Now I am looking at the routing table');
	});

	it('falls back rather than flickering down to a bare opener', () => {
		const text = 'I need to compare both configs before deciding. So';
		expect(reasoningNote(text)).toBe('I need to compare both configs before deciding.');
	});

	it('collapses the whitespace a streamed thought arrives with', () => {
		expect(reasoningNote('Checking\n\n   the\tcache  layer')).toBe('Checking the cache layer');
	});

	it('strips markdown that would render as a typo in a plain line', () => {
		expect(reasoningNote('### Plan')).toBe('Plan');
		expect(reasoningNote('- **check** the `cache`')).toBe('- check the cache');
		expect(reasoningNote('Working on it ```js\nconst x = 1;\n```')).toBe('Working on it');
	});

	it('does not split a decimal into its own sentence', () => {
		// "took 0.4 seconds" used to yield a note reading "4 seconds".
		expect(reasoningNote('The call took 0.4 seconds')).toBe('The call took 0.4 seconds');
	});

	it('caps the line so it cannot wrap and shift the page', () => {
		const long = `I am ${'considering '.repeat(40)}options`;
		const note = reasoningNote(long);
		expect(note.length).toBeLessThanOrEqual(REASONING_NOTE_MAX + 1);
		expect(note.endsWith('…')).toBe(true);
		expect(note).not.toContain('  ');
	});

	it('breaks a capped line on a word', () => {
		const note = reasoningNote('alpha bravo charlie delta echo foxtrot golf hotel', 20);
		expect(note).toBe('alpha bravo charlie…');
	});

	it('cuts mid-word rather than returning a lone ellipsis', () => {
		expect(reasoningNote('Supercalifragilisticexpialidocious', 12)).toBe('Supercalifra…');
	});

	it('is stable as more of the same sentence arrives', () => {
		// The line is re-rendered on every note; one that jumped between
		// sentences as tokens landed read as flicker rather than as progress.
		expect(reasoningNote('Reading the schema no')).toBe('Reading the schema no');
		expect(reasoningNote('Reading the schema now')).toBe('Reading the schema now');
	});
});

describe('reasoningNotes', () => {
	const feedAll = (sink: (d: string) => void, text: string) => {
		for (const word of text.split(' ')) sink(word + ' ');
	};

	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it('does nothing at all without somewhere to send notes', () => {
		// research calls frameQuestion and friends directly from tests, with no
		// job to push to; a no-op sink saves every caller a branch.
		const sink = reasoningNotes();
		expect(() => feedAll(sink, 'a'.repeat(50))).not.toThrow();
	});

	it('emits the first note as soon as there is one worth reading', () => {
		const notes: string[] = [];
		const sink = reasoningNotes((t) => notes.push(t));
		const thought = 'Checking whether the cache layer is the problem here';
		feedAll(sink, thought);
		expect(notes).toHaveLength(1);
		// The note is the thought so far, caught at the first moment it read as
		// anything — a prefix, not the finished sentence. That is the point: a
		// line that waited for the sentence to end would be the stale one.
		expect(notes[0].length).toBeGreaterThanOrEqual(12);
		expect(thought.startsWith(notes[0])).toBe(true);
	});

	it('holds a fragment back until it says something', () => {
		const notes: string[] = [];
		const sink = reasoningNotes((t) => notes.push(t));
		sink('So ');
		expect(notes).toHaveLength(0);
	});

	it('rate-limits the notes rather than sending one per token', () => {
		// Reasoning arrives token by token. A chunk per token is a lot of wire
		// for text nobody reads word by word.
		const notes: string[] = [];
		const sink = reasoningNotes((t) => notes.push(t));
		feedAll(sink, 'The first complete thought about the cache');
		feedAll(sink, 'and a great deal more thinking immediately after it');
		expect(notes).toHaveLength(1);
		vi.advanceTimersByTime(REASONING_NOTE_INTERVAL_MS + 1);
		feedAll(sink, 'and now a later thought worth showing');
		expect(notes).toHaveLength(2);
		expect(notes[1]).not.toBe(notes[0]);
	});

	it('keeps the buffer bounded on a long think', () => {
		const notes: string[] = [];
		const sink = reasoningNotes((t) => notes.push(t));
		for (let i = 0; i < 400; i++) {
			sink('thinking about it at some length. ');
			vi.advanceTimersByTime(REASONING_NOTE_INTERVAL_MS + 1);
		}
		// Still producing readable notes rather than degrading as it grows.
		expect(notes.length).toBeGreaterThan(100);
		for (const n of notes) expect(n.length).toBeLessThanOrEqual(REASONING_NOTE_MAX + 1);
	});

	it('gives each model call its own buffer', () => {
		// One per call, not per run: carrying a leg's thought over showed a note
		// about work that had already finished.
		const a: string[] = [];
		const b: string[] = [];
		const first = reasoningNotes((t) => a.push(t));
		const second = reasoningNotes((t) => b.push(t));
		feedAll(first, 'Looking at the routing table for the answer');
		feedAll(second, 'Reading the schema migration instead');
		expect(a[0].startsWith('Looking at the')).toBe(true);
		expect(b[0].startsWith('Reading the')).toBe(true);
	});
});
