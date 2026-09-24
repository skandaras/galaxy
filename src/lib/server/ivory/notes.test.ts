import { describe, expect, it } from 'vitest';
import { GOOD_NOTE } from './github-fixture';
import { noteClaims, validateNote } from './notes';

describe('validateNote', () => {
	it('passes a note written to the template', () => {
		expect(validateNote(GOOD_NOTE, { project: 'bees' })).toEqual([]);
	});

	it('names every problem at once', () => {
		const bad = GOOD_NOTE.replace('access: abstract-only', 'access: skimmed')
			.replace('- Quote: "dance duration scales with patch profitability"', '- Quote: ""')
			.replace('- Location: abstract', '- Location:')
			.replace('authors: [Thomas D. Seeley]', 'authors: []');
		expect(validateNote(bad, { project: 'bees' })).toEqual([
			'`authors` must list at least one author (use an organisation if there is no person).',
			'`access` must be full-text or abstract-only.',
			'Claim "N-002.1" has no quote. No quote, no claim: add a short verbatim quote or remove the claim.',
			'Claim "N-002.1" has no location (section, page or figure).'
		]);
	});

	it('wants the claims numbered under the note', () => {
		expect(validateNote(GOOD_NOTE.replace('### N-002.1', '### Claim one'), { project: 'bees' })).toContain(
			'Claim "Claim one" should be numbered N-002.1, N-002.2 and so on.'
		);
	});

	it('refuses a note without frontmatter, or for another project', () => {
		expect(validateNote('# Notes', { project: 'bees' })).toEqual([
			'The note has no frontmatter. Start from the note template.'
		]);
		expect(validateNote(GOOD_NOTE, { project: 'wasps' })).toContain('`project` must be wasps.');
	});
});

describe('noteClaims', () => {
	it('ignores the template comment and reads each field', () => {
		expect(noteClaims(GOOD_NOTE.split('---').slice(2).join('---'))).toEqual([
			{
				heading: 'N-002.1',
				claim: 'Foragers advertise richer patches with longer dances.',
				quote: 'dance duration scales with patch profitability',
				location: 'abstract'
			}
		]);
	});
});
