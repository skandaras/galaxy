import { describe, expect, it } from 'vitest';
import { githubRepoSlug } from './pull-request';

describe('githubRepoSlug', () => {
	it('reads owner/repo off a clone URL', () => {
		expect(githubRepoSlug('https://github.com/skandaras/galaxy.git')).toBe('skandaras/galaxy');
		expect(githubRepoSlug('https://github.com/skandaras/galaxy')).toBe('skandaras/galaxy');
		expect(githubRepoSlug('https://github.com/skandaras/galaxy/')).toBe('skandaras/galaxy');
	});

	it('tolerates surrounding whitespace, which a pasted URL carries', () => {
		expect(githubRepoSlug('  https://github.com/a/b.git ')).toBe('a/b');
	});

	it('returns null for anywhere that is not github.com', () => {
		// A session can be opened against any git URL, and pull requests are a
		// GitHub feature — the tool has to say so rather than guess an API host.
		expect(githubRepoSlug('https://gitlab.com/a/b.git')).toBeNull();
		expect(githubRepoSlug('git@github.com:a/b.git')).toBeNull();
		expect(githubRepoSlug('file:///tmp/origin.git')).toBeNull();
		expect(githubRepoSlug('')).toBeNull();
	});
});
