import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir, runMigrations } from '$lib/server/db';
import {
	authenticatedUrl,
	createWorkspace,
	destroyWorkspace,
	gitAuthArgs,
	mergeIntoBranch,
	repoInstructions,
	safeJoin,
	scrubSecrets,
	shellQuote
} from './workspace';

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

describe('repoInstructions', () => {
	const INSTR = 'workspaces/instr-ws';
	const write = (name: string, body: string) =>
		writeFileSync(join(dataDir, INSTR, name), body);

	beforeAll(() => {
		rmSync(join(dataDir, INSTR), { recursive: true, force: true });
		mkdirSync(join(dataDir, INSTR), { recursive: true });
	});

	it('is empty when the repo says nothing, which most do', () => {
		expect(repoInstructions(INSTR)).toBe('');
	});

	it('folds in AGENTS.md and says it outranks general habits', () => {
		write('AGENTS.md', 'Always run npm run check before committing.');
		const out = repoInstructions(INSTR);
		expect(out).toContain('Always run npm run check');
		expect(out).toContain('outrank');
	});

	it('reads CLAUDE.md too, since plenty of repos carry only that', () => {
		rmSync(join(dataDir, INSTR, 'AGENTS.md'));
		write('CLAUDE.md', 'Prefer tabs.');
		expect(repoInstructions(INSTR)).toContain('Prefer tabs');
	});

	it('does not repeat the same content under both names', () => {
		write('AGENTS.md', 'Prefer tabs.');
		write('CLAUDE.md', 'Prefer tabs.');
		// The two are commonly one file linked twice; paying for it twice on
		// every leg is the whole reason this dedupes.
		expect(repoInstructions(INSTR).match(/Prefer tabs/g)).toHaveLength(1);
	});

	it('truncates rather than letting a huge file take over the prompt', () => {
		write('AGENTS.md', 'x'.repeat(20_000));
		rmSync(join(dataDir, INSTR, 'CLAUDE.md'));
		const out = repoInstructions(INSTR);
		expect(out).toContain('…(truncated)');
		expect(out.length).toBeLessThan(9_000);
	});
});

/**
 * Real git against a real local origin, not a mock.
 *
 * `getExecutor()` defaults to the local executor and every vitest worker has its
 * own DATA_DIR, so a bare repository under it is the cheapest honest way to
 * exercise branching and merging. Mocking git here would have tested the shell
 * strings and nothing about whether the sequence works.
 */
describe('branching and merging', () => {
	const ORIGIN = join(dataDir, 'origin-work');
	const BARE = `${ORIGIN}.git`;
	/** Committing in the fixture, where no user is configured. */
	const AS = '-c user.email=t@t -c user.name=t';

	const git = (cwd: string, args: string) =>
		execSync(`git ${args}`, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

	const made: string[] = [];
	const clone = async (opts?: { from?: string }) => {
		const ws = await createWorkspace(BARE, opts);
		made.push(ws.workspaceRel);
		return ws;
	};
	/** Commit a file on whatever branch the workspace is on. */
	const commit = (ws: string, file: string, body: string) => {
		const dir = join(dataDir, ws);
		writeFileSync(join(dir, file), body);
		git(dir, `add -A`);
		git(dir, `${AS} commit -qm ${JSON.stringify(`add ${file}`)}`);
	};

	beforeAll(() => {
		// gitAuthArgs reads the stored GitHub token, so this suite needs the
		// settings table even though nothing here is authenticated.
		runMigrations();
		rmSync(ORIGIN, { recursive: true, force: true });
		rmSync(BARE, { recursive: true, force: true });
		mkdirSync(ORIGIN, { recursive: true });
		git(ORIGIN, 'init -q -b main');
		writeFileSync(join(ORIGIN, 'README.md'), 'line one\n');
		git(ORIGIN, 'add -A');
		git(ORIGIN, `${AS} commit -qm init`);
		git(dataDir, `clone -q --bare ${JSON.stringify(ORIGIN)} ${JSON.stringify(BARE)}`);
	});

	afterAll(() => {
		for (const ws of made) destroyWorkspace(ws);
	});

	it('starts from the default head when no branch is named', async () => {
		const ws = await clone();
		expect(ws.baseBranch).toBe('main');
		expect(ws.workBranch).toMatch(/^galaxy\/session-/);
	});

	it('falls back to the default head when the branch is not on the remote yet', async () => {
		// Forge's integration branch does not exist until the first green task
		// pushes it, so every clone before that legitimately lands on the base.
		const ws = await clone({ from: 'forge/not-yet' });
		expect(ws.baseBranch).toBe('main');
	});

	it('merges a work branch into a branch that does not exist yet, and pushes it', async () => {
		const ws = await clone();
		commit(ws.workspaceRel, 'first.txt', 'from task one\n');

		const merged = await mergeIntoBranch(ws.workspaceRel, BARE, {
			target: 'forge/demo',
			source: ws.workBranch,
			baseBranch: ws.baseBranch
		});
		expect(merged.ok).toBe(true);
		// The point of the whole exercise: the next task can clone this.
		expect(git(BARE, 'branch --list forge/demo')).toContain('forge/demo');
		expect(git(BARE, 'log --oneline forge/demo')).toContain('add first.txt');
	});

	it('then starts the next task from that branch, carrying what landed', async () => {
		const ws = await clone({ from: 'forge/demo' });
		expect(ws.baseBranch).toBe('forge/demo');
		expect(existsSync(join(dataDir, ws.workspaceRel, 'first.txt'))).toBe(true);

		commit(ws.workspaceRel, 'second.txt', 'from task two\n');
		const merged = await mergeIntoBranch(ws.workspaceRel, BARE, {
			target: 'forge/demo',
			source: ws.workBranch,
			baseBranch: ws.baseBranch
		});
		expect(merged.ok).toBe(true);
		expect(git(BARE, 'log --oneline forge/demo')).toContain('add second.txt');
	});

	it('reports a conflict instead of throwing, and leaves no half-merge behind', async () => {
		// Two tasks editing the same line is the case a driver has to survive: it
		// parks the task exactly as a failing test would, and the branch it could
		// not land on must be untouched.
		const a = await clone({ from: 'forge/demo' });
		const b = await clone({ from: 'forge/demo' });
		commit(a.workspaceRel, 'README.md', 'rewritten by A\n');
		commit(b.workspaceRel, 'README.md', 'rewritten by B\n');

		expect(
			(
				await mergeIntoBranch(a.workspaceRel, BARE, {
					target: 'forge/demo',
					source: a.workBranch,
					baseBranch: a.baseBranch
				})
			).ok
		).toBe(true);

		const second = await mergeIntoBranch(b.workspaceRel, BARE, {
			target: 'forge/demo',
			source: b.workBranch,
			baseBranch: b.baseBranch
		});
		expect(second.ok).toBe(false);
		expect(second.output).toMatch(/conflict/i);
		// `git merge --abort` ran: nothing is left staged or unmerged.
		expect(git(join(dataDir, b.workspaceRel), 'status --porcelain').trim()).toBe('');
		// And A's work is still what the branch holds.
		expect(git(BARE, 'show forge/demo:README.md')).toContain('rewritten by A');
	});
});
