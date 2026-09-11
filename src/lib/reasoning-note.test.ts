import { describe, it, expect } from 'vitest';
import { REASONING_NOTE_MAX, reasoningNote } from './reasoning-note';

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
