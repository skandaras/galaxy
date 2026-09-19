import { describe, expect, it } from 'vitest';
import {
	AUTOSAVE_RETRY_MS,
	deriveTitle,
	hasContent,
	retryDelay,
	titleForNew,
	untitledName
} from './library-autosave';

describe('hasContent', () => {
	it('is false for a document nobody has typed in', () => {
		expect(hasContent('', '')).toBe(false);
	});

	it('does not count whitespace as having typed something', () => {
		expect(hasContent('   ', '\n\n \t')).toBe(false);
	});

	it('is true on a title alone, and on a body alone', () => {
		expect(hasContent('Roast potatoes', '')).toBe(true);
		expect(hasContent('', 'goose fat, and plenty of it')).toBe(true);
	});
});

describe('deriveTitle', () => {
	it('takes the first line that has words in it', () => {
		expect(deriveTitle('\n\n   \nRoast potatoes\nMethod: …')).toBe('Roast potatoes');
	});

	it('strips the markdown that makes a line a heading', () => {
		expect(deriveTitle('# Roast potatoes')).toBe('Roast potatoes');
		expect(deriveTitle('### Roast potatoes')).toBe('Roast potatoes');
	});

	it('strips bullets, numbers and quote marks, including nested', () => {
		expect(deriveTitle('- Roast potatoes')).toBe('Roast potatoes');
		expect(deriveTitle('1. Roast potatoes')).toBe('Roast potatoes');
		expect(deriveTitle('> ## Roast potatoes')).toBe('Roast potatoes');
	});

	it('skips a line that is only punctuation', () => {
		// A thematic break or a setext underline is not what the document is about.
		expect(deriveTitle('---\nRoast potatoes')).toBe('Roast potatoes');
		expect(deriveTitle('***\n===\nRoast potatoes')).toBe('Roast potatoes');
	});

	it('caps a long first line rather than putting a paragraph in the shelf', () => {
		const derived = deriveTitle('x'.repeat(200));
		expect(derived.length).toBeLessThanOrEqual(61);
		expect(derived.endsWith('…')).toBe(true);
	});

	it('gives nothing back when there is nothing usable', () => {
		expect(deriveTitle('')).toBe('');
		expect(deriveTitle('\n\n   \n')).toBe('');
		expect(deriveTitle('---\n***')).toBe('');
	});
});

describe('untitledName', () => {
	it('starts at one', () => {
		expect(untitledName([])).toBe('Untitled 1');
		expect(untitledName(['Roast potatoes'])).toBe('Untitled 1');
	});

	it('counts past the highest rather than the number of documents', () => {
		// Deleting Untitled 2 must not make the next one collide with Untitled 3.
		expect(untitledName(['Untitled 1', 'Untitled 3'])).toBe('Untitled 4');
	});

	it('ignores a title that merely starts with the word', () => {
		expect(untitledName(['Untitled thoughts', 'Untitled'])).toBe('Untitled 1');
	});
});

describe('titleForNew', () => {
	it('prefers what the person typed', () => {
		expect(titleForNew('  My notes  ', '# Something else', [])).toBe('My notes');
	});

	it('falls back to the first line of the body', () => {
		expect(titleForNew('', '# Roast potatoes\nMethod', [])).toBe('Roast potatoes');
	});

	it('falls back to a number only when the body has no words', () => {
		expect(titleForNew('', '---\n***', ['Untitled 1'])).toBe('Untitled 2');
	});
});

describe('retryDelay', () => {
	it('climbs and then holds, so a server that is gone is not hammered', () => {
		expect(retryDelay(0)).toBe(AUTOSAVE_RETRY_MS[0]);
		expect(retryDelay(1)).toBe(AUTOSAVE_RETRY_MS[1]);
		expect(retryDelay(2)).toBe(AUTOSAVE_RETRY_MS[2]);
		expect(retryDelay(99)).toBe(AUTOSAVE_RETRY_MS[AUTOSAVE_RETRY_MS.length - 1]);
	});
});
