import { describe, it, expect } from 'vitest';
import { makeSnippet, slugify } from './library';

describe('slugify', () => {
	it('produces url-safe ids', () => {
		expect(slugify('Deploy Notes: v2 (draft)')).toBe('deploy-notes-v2-draft');
		expect(slugify('  ')).toBe('untitled');
	});
});

describe('makeSnippet', () => {
	it('strips markdown and collapses whitespace', () => {
		expect(makeSnippet('# Title\n\nSome **bold** text with `code`.\n- a list')).toBe(
			'Title Some bold text with code. - a list'
		);
	});
	it('skips frontmatter and truncates', () => {
		const s = makeSnippet(`---\nkey: value\n---\n${'word '.repeat(100)}`, 40);
		expect(s.startsWith('word word')).toBe(true);
		expect(s.length).toBeLessThanOrEqual(40);
	});
});
