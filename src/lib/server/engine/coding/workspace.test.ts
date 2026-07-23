import { describe, it, expect, beforeAll } from 'vitest';
import { mkdirSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from '$lib/server/db';
import { authenticatedUrl, gitAuthArgs, safeJoin, scrubSecrets, shellQuote } from './workspace';

const WS = 'workspaces/test-ws';

beforeAll(() => {
	rmSync(join(dataDir, WS), { recursive: true, force: true });
	mkdirSync(join(dataDir, WS, 'sub'), { recursive: true });
	writeFileSync(join(dataDir, WS, 'sub', 'ok.txt'), 'fine');
	symlinkSync('/etc', join(dataDir, WS, 'evil'));
});

describe('safeJoin', () => {
	it('resolves paths inside the workspace', () => {
		expect(safeJoin(WS, 'sub/ok.txt')).toContain('sub/ok.txt');
		expect(safeJoin(WS, './sub')).toContain('sub');
	});

	it('rejects lexical escapes', () => {
		expect(() => safeJoin(WS, '../other')).toThrow(/escapes/);
		expect(() => safeJoin(WS, '../../etc/passwd')).toThrow(/escapes/);
		expect(() => safeJoin(WS, 'a/../../../x')).toThrow(/escapes/);
	});

	it('rejects symlink escapes (planted link pointing outside)', () => {
		expect(() => safeJoin(WS, 'evil/passwd')).toThrow(/symlink/);
		expect(() => safeJoin(WS, 'evil')).toThrow(/symlink/);
	});

	it('allows the workspace root itself', () => {
		expect(() => safeJoin(WS, '.')).not.toThrow();
	});
});

describe('gitAuthArgs', () => {
	it('builds an extraheader flag for github.com only', () => {
		const args = gitAuthArgs('https://github.com/a/b.git', 'tok');
		expect(args).toContain('http.extraheader=AUTHORIZATION: basic ');
		expect(args).toContain(Buffer.from('x-access-token:tok').toString('base64'));
		expect(gitAuthArgs('https://gitlab.com/a/b.git', 'tok')).toBe('');
		expect(gitAuthArgs('/local/repo.git', 'tok')).toBe('');
		expect(gitAuthArgs('https://github.com/a/b.git', '')).toBe('');
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
	it('removes auth headers echoed by git', () => {
		expect(scrubSecrets('AUTHORIZATION: basic eC1hY2Nlc3M=')).toBe('AUTHORIZATION: basic ***');
	});
});

describe('shellQuote', () => {
	it('quotes safely', () => {
		expect(shellQuote("it's")).toBe(`'it'\\''s'`);
		expect(shellQuote('plain')).toBe(`'plain'`);
	});
});
