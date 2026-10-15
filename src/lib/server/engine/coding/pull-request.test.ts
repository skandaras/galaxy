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

	it('rejects anything beyond a plain owner/repo path', () => {
		// The query case is the one that mattered: the old pattern returned
		// `o/r?access_token=secret` as the slug.
		for (const url of [
			'https://github.com/o/r?access_token=secret',
			'https://github.com/o/r#x',
			'https://user:tok@github.com/o/r.git',
			'https://github.com:8443/o/r',
			'http://github.com/o/r',
			'https://github.com/o/r/extra',
			'https://github.com/o/r%2Fx'
		]) {
			expect(githubRepoSlug(url)).toBeNull();
		}
	});
});
