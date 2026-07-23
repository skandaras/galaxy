import { describe, it, expect } from 'vitest';
import { authenticatedUrl, safeJoin, scrubSecrets, shellQuote } from './workspace';

describe('safeJoin', () => {
	it('resolves paths inside the workspace', () => {
		expect(safeJoin('workspaces/abc', 'src/app.ts')).toContain('workspaces/abc/src/app.ts');
		expect(safeJoin('workspaces/abc', './README.md')).toContain('workspaces/abc/README.md');
	});

	it('rejects escapes', () => {
		expect(() => safeJoin('workspaces/abc', '../other')).toThrow(/escapes/);
		expect(() => safeJoin('workspaces/abc', '../../etc/passwd')).toThrow(/escapes/);
		expect(() => safeJoin('workspaces/abc', 'a/../../../x')).toThrow(/escapes/);
	});

	it('allows the workspace root itself', () => {
		expect(() => safeJoin('workspaces/abc', '.')).not.toThrow();
	});
});

describe('authenticatedUrl', () => {
	it('injects tokens only for github.com https urls', () => {
		expect(authenticatedUrl('https://github.com/a/b.git', 'tok')).toBe(
			'https://x-access-token:tok@github.com/a/b.git'
		);
		expect(authenticatedUrl('https://gitlab.com/a/b.git', 'tok')).toBe(
			'https://gitlab.com/a/b.git'
		);
		expect(authenticatedUrl('/local/path/repo.git', 'tok')).toBe('/local/path/repo.git');
		expect(authenticatedUrl('https://github.com/a/b.git', undefined)).toBe(
			'https://github.com/a/b.git'
		);
	});
});

describe('scrubSecrets', () => {
	it('removes embedded tokens', () => {
		expect(scrubSecrets('fatal: https://x-access-token:ghp_secret123@github.com/a/b')).toBe(
			'fatal: https://x-access-token:***@github.com/a/b'
		);
	});
});

describe('shellQuote', () => {
	it('quotes safely', () => {
		expect(shellQuote("it's")).toBe(`'it'\\''s'`);
		expect(shellQuote('plain')).toBe(`'plain'`);
	});
});
