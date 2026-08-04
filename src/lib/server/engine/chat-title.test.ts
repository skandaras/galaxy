import { describe, expect, it } from 'vitest';
import { cleanTitle } from './chat-title';

describe('cleanTitle', () => {
	it('takes the title as given when the model behaves', () => {
		expect(cleanTitle('Postgres connection pooling')).toBe('Postgres connection pooling');
	});

	it('strips the decorations models add anyway', () => {
		// All observed in practice despite asking for "the title alone".
		expect(cleanTitle('"Nebula formation"')).toBe('Nebula formation');
		expect(cleanTitle('Title: Deploy checklist')).toBe('Deploy checklist');
		expect(cleanTitle('“Curly quoted”')).toBe('Curly quoted');
		expect(cleanTitle('Rate limiting strategies.')).toBe('Rate limiting strategies');
	});

	it('keeps only the first line, ignoring any commentary after it', () => {
		expect(cleanTitle('SQLite indexing\n\nThis title covers the discussion of…')).toBe(
			'SQLite indexing'
		);
	});

	it('bounds the length, so one bad reply cannot fill the list', () => {
		expect(cleanTitle('x'.repeat(200))).toHaveLength(60);
	});

	it('returns empty for a reply with nothing usable in it', () => {
		expect(cleanTitle('')).toBe('');
		expect(cleanTitle('   \n  ')).toBe('');
		expect(cleanTitle('""')).toBe('');
	});

	it('leaves internal punctuation alone', () => {
		expect(cleanTitle('CI: green, then red')).toBe('CI: green, then red');
	});
});
