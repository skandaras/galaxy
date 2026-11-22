import { beforeEach, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from '$lib/server/db';
import {
	changedPaths,
	diffStat,
	restoreTree,
	runCheck,
	sameFingerprint,
	treeFingerprint
} from './snapshot';

const WS = 'workspaces/snapshot-test';
const abs = (...p: string[]) => join(dataDir, WS, ...p);
const git = (cmd: string) =>
	execSync(`git ${cmd}`, { cwd: abs(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const status = () => git('status --porcelain=v1 -uall');
/** Paths marked with git add -N: against the index, the only kind that reads as added. */
const intents = () => git('diff --name-only -z --diff-filter=A').split('\0').filter(Boolean);

beforeEach(() => {
	rmSync(abs(), { recursive: true, force: true });
	mkdirSync(abs('src'), { recursive: true });
	git('init -q -b main');
	git('config user.email t@example.invalid');
	git('config user.name Test');
	writeFileSync(abs('.gitignore'), 'cache/\n');
	writeFileSync(abs('src', 'a.txt'), 'one\n');
	writeFileSync(abs('src', 'b.txt'), 'two\n');
	git('add -A');
	git('commit -q -m first');
});

const fp = async () => (await treeFingerprint(WS))!;

describe('treeFingerprint', () => {
	it('is null outside a git work tree', async () => {
		const rel = 'workspaces/snapshot-plain';
		mkdirSync(join(dataDir, rel), { recursive: true });
		expect(await treeFingerprint(rel)).toBeNull();
		rmSync(join(dataDir, rel), { recursive: true, force: true });
	});

	it('does not change when only ignored files are written', async () => {
		const before = await fp();
		mkdirSync(abs('cache'), { recursive: true });
		writeFileSync(abs('cache', 'x.bin'), 'junk');
		expect(sameFingerprint(before, await fp())).toBe(true);
	});

	it('changes for a new, a modified and a deleted file', async () => {
		const clean = await fp();
		writeFileSync(abs('src', 'new.txt'), 'n\n');
		const added = await fp();
		expect(added.tree).not.toBe(clean.tree);
		rmSync(abs('src', 'new.txt'));
		expect(sameFingerprint(clean, await fp())).toBe(true);

		writeFileSync(abs('src', 'a.txt'), 'changed\n');
		expect((await fp()).tree).not.toBe(clean.tree);
		writeFileSync(abs('src', 'a.txt'), 'one\n');

		rmSync(abs('src', 'b.txt'));
		expect((await fp()).tree).not.toBe(clean.tree);
	});

	it('changes when a commit is made, even though the files are the same', async () => {
		writeFileSync(abs('src', 'a.txt'), 'changed\n');
		const before = await fp();
		git('add -A');
		git('commit -q -m second');
		const after = await fp();
		expect(after.tree).toBe(before.tree);
		expect(sameFingerprint(before, after)).toBe(false);
		expect(after.head).not.toBe(before.head);
		expect(after.ref).toBe('refs/heads/main');
	});

	it('leaves the real index alone', async () => {
		writeFileSync(abs('src', 'new.txt'), 'n\n');
		const before = status();
		await fp();
		expect(status()).toBe(before);
	});

	it('changes when only what is staged changed', async () => {
		writeFileSync(abs('src', 'a.txt'), 'edited\n');
		const before = await fp();
		git('add src/a.txt');
		const after = await fp();
		expect(after.tree).toBe(before.tree);
		expect(sameFingerprint(before, after)).toBe(false);
	});

	it('changes when an intent-to-add empty file becomes staged', async () => {
		writeFileSync(abs('src', 'empty.txt'), '');
		git('add -N src/empty.txt');
		const before = await fp();
		git('add src/empty.txt');
		expect(sameFingerprint(before, await fp())).toBe(false);
	});

	it('reads a repository with no commits', async () => {
		rmSync(abs(), { recursive: true, force: true });
		mkdirSync(abs(), { recursive: true });
		git('init -q -b main');
		writeFileSync(abs('f.txt'), 'x\n');
		const f = await fp();
		expect(f.head).toBe('');
		expect(f.ref).toBe('refs/heads/main');
		expect(f.tree).toMatch(/^[0-9a-f]{40,64}$/);
	});
});

describe('restoreTree', () => {
	it('round-trips uncommitted work and keeps git status as it was', async () => {
		// An earlier task's output: one new file, one edit, neither committed.
		writeFileSync(abs('src', 'earlier.txt'), 'from an earlier task\n');
		writeFileSync(abs('src', 'a.txt'), 'edited\n');
		const t0 = await fp();
		const statusAtT0 = status();

		writeFileSync(abs('src', 'a.txt'), 'worker rewrote it\n');
		writeFileSync(abs('src', 'earlier.txt'), 'worker rewrote this too\n');
		writeFileSync(abs('src', 'made-later.txt'), 'x\n');
		rmSync(abs('src', 'b.txt'));
		mkdirSync(abs('deep/er'), { recursive: true });
		writeFileSync(abs('deep/er/f.txt'), 'x\n');

		await restoreTree(WS, t0.tree);

		expect(readFileSync(abs('src', 'a.txt'), 'utf8')).toBe('edited\n');
		expect(readFileSync(abs('src', 'earlier.txt'), 'utf8')).toBe('from an earlier task\n');
		expect(readFileSync(abs('src', 'b.txt'), 'utf8')).toBe('two\n');
		expect(existsSync(abs('src', 'made-later.txt'))).toBe(false);
		expect(existsSync(abs('deep/er/f.txt'))).toBe(false);
		expect((await fp()).tree).toBe(t0.tree);
		// The new file is still untracked and the edit still unstaged: reading
		// the tree into the real index would have staged both.
		expect(status()).toBe(statusAtT0);
	});

	it('leaves ignored files alone', async () => {
		const t0 = await fp();
		mkdirSync(abs('cache'), { recursive: true });
		writeFileSync(abs('cache', 'built.bin'), 'expensive');
		writeFileSync(abs('src', 'made-later.txt'), 'x\n');
		await restoreTree(WS, t0.tree);
		expect(readFileSync(abs('cache', 'built.bin'), 'utf8')).toBe('expensive');
		expect(existsSync(abs('src', 'made-later.txt'))).toBe(false);
	});

	it('undoes a file the worker added to the index itself', async () => {
		const t0 = await fp();
		const statusAtT0 = status();
		writeFileSync(abs('src', 'staged.txt'), 'x\n');
		git('add src/staged.txt');
		rmSync(abs('src', 'b.txt'));
		await restoreTree(WS, t0.tree);
		expect(existsSync(abs('src', 'staged.txt'))).toBe(false);
		expect(status()).toBe(statusAtT0);
	});

	it('keeps a file that was deleted at capture deleted', async () => {
		rmSync(abs('src', 'b.txt'));
		const t0 = await fp();
		const statusAtT0 = status();
		writeFileSync(abs('src', 'b.txt'), 'recreated\n');
		await restoreTree(WS, t0.tree);
		expect(existsSync(abs('src', 'b.txt'))).toBe(false);
		expect(status()).toBe(statusAtT0);
	});

	it('keeps a file that was ignored before a worker deleted the rule', async () => {
		mkdirSync(abs('cache'), { recursive: true });
		writeFileSync(abs('cache', 'built.bin'), 'expensive');
		const t0 = await fp();
		writeFileSync(abs('.gitignore'), '');
		await restoreTree(WS, t0.tree, t0);
		expect(readFileSync(abs('cache', 'built.bin'), 'utf8')).toBe('expensive');
		expect(readFileSync(abs('.gitignore'), 'utf8')).toBe('cache/\n');
	});

	it('removes a .gitignore the worker added, and what it hid', async () => {
		const t0 = await fp();
		const statusAtT0 = status();
		mkdirSync(abs('sub'), { recursive: true });
		writeFileSync(abs('sub', '.gitignore'), 'junk\n');
		writeFileSync(abs('sub', 'junk'), 'x\n');
		await restoreTree(WS, t0.tree, t0);
		expect(existsSync(abs('sub', '.gitignore'))).toBe(false);
		expect(existsSync(abs('sub', 'junk'))).toBe(false);
		expect(status()).toBe(statusAtT0);
	});

	it('unstages an edit the worker staged to a tracked file', async () => {
		const t0 = await fp();
		writeFileSync(abs('src', 'a.txt'), 'worker\n');
		git('add src/a.txt');
		await restoreTree(WS, t0.tree, t0);
		expect(git('diff --cached --name-only')).toBe('');
		expect(readFileSync(abs('src', 'a.txt'), 'utf8')).toBe('one\n');
		expect(status()).toBe('');
	});

	it('keeps what the person had staged before the task', async () => {
		writeFileSync(abs('src', 'a.txt'), 'mine\n');
		git('add src/a.txt');
		const t0 = await fp();
		const statusAtT0 = status();
		writeFileSync(abs('src', 'b.txt'), 'worker\n');
		git('add src/b.txt');
		await restoreTree(WS, t0.tree, t0);
		expect(git('diff --cached --name-only').trim()).toBe('src/a.txt');
		expect(status()).toBe(statusAtT0);
	});

	it('keeps a path the person had marked with git add -N', async () => {
		writeFileSync(abs('src', 'intended.txt'), 'later\n');
		git('add -N src/intended.txt');
		const t0 = await fp();
		const statusAtT0 = status();
		writeFileSync(abs('src', 'b.txt'), 'worker\n');
		git('add src/b.txt');
		await restoreTree(WS, t0.tree, t0);
		expect(status()).toBe(statusAtT0);
		expect(intents()).toEqual(['src/intended.txt']);
	});

	it('puts back a directory a worker replaced with a staged file', async () => {
		mkdirSync(abs('dir'), { recursive: true });
		writeFileSync(abs('dir', '.gitignore'), 'tmp\n');
		writeFileSync(abs('dir', 'kept.txt'), 'k\n');
		git('add -A');
		git('commit -q -m dir');
		const t0 = await fp();
		rmSync(abs('dir'), { recursive: true, force: true });
		writeFileSync(abs('dir'), 'now a file\n');
		git('add -A');
		await restoreTree(WS, t0.tree, t0);
		expect(readFileSync(abs('dir', 'kept.txt'), 'utf8')).toBe('k\n');
		expect(readFileSync(abs('dir', '.gitignore'), 'utf8')).toBe('tmp\n');
		expect(status()).toBe('');
	});

	it('removes a rule that another added rule was hiding', async () => {
		const t0 = await fp();
		mkdirSync(abs('outer', 'inner'), { recursive: true });
		writeFileSync(abs('outer', '.gitignore'), 'inner/.gitignore\n');
		writeFileSync(abs('outer', 'inner', '.gitignore'), 'junk\n');
		writeFileSync(abs('outer', 'inner', 'junk'), 'x\n');
		await restoreTree(WS, t0.tree, t0);
		expect(existsSync(abs('outer'))).toBe(false);
	});

	it('keeps index flags on other paths when the worker staged something', async () => {
		git('update-index --skip-worktree src/b.txt');
		const t0 = await fp();
		writeFileSync(abs('src', 'a.txt'), 'worker\n');
		git('add src/a.txt');
		await restoreTree(WS, t0.tree, t0);
		expect(git('ls-files -t src/b.txt').trim()).toBe('S src/b.txt');
		expect(git('diff --cached --name-only')).toBe('');
	});

	it('keeps an intent-to-add entry whose file was deleted', async () => {
		writeFileSync(abs('src', 'gone.txt'), 'g\n');
		git('add -N src/gone.txt');
		rmSync(abs('src', 'gone.txt'));
		const t0 = await fp();
		writeFileSync(abs('src', 'a.txt'), 'worker\n');
		git('add src/a.txt');
		await restoreTree(WS, t0.tree, t0);
		expect(git('ls-files src/gone.txt').trim()).toBe('src/gone.txt');
	});

	it('keeps index flags when the worker did not touch staging', async () => {
		git('update-index --skip-worktree src/b.txt');
		const t0 = await fp();
		writeFileSync(abs('src', 'made.txt'), 'x\n');
		await restoreTree(WS, t0.tree, t0);
		expect(git('ls-files -t src/b.txt').trim()).toBe('S src/b.txt');
	});

	it('round-trips an intent-to-add path whose name git would quote or match', async () => {
		const name = 'we"ird\t*name';
		writeFileSync(abs('src', name), 'later\n');
		writeFileSync(abs('src', 'weXirdXname'), 'other\n');
		git(`add -N -- ':(literal)src/${name}'`);
		const t0 = await fp();
		writeFileSync(abs('src', 'b.txt'), 'worker\n');
		git('add src/b.txt');
		await restoreTree(WS, t0.tree, t0);
		expect(intents()).toEqual([`src/${name}`]);
	});

	it('removes a file deleted at capture that the worker unstaged and wrote again', async () => {
		rmSync(abs('src', 'b.txt'));
		const t0 = await fp();
		const statusAtT0 = status();
		git('rm -q --cached src/b.txt');
		writeFileSync(abs('src', 'b.txt'), 'worker\n');
		await restoreTree(WS, t0.tree, t0);
		expect(existsSync(abs('src', 'b.txt'))).toBe(false);
		expect(status()).toBe(statusAtT0);
	});

	it('restores ordinary files even when the worker left a repository git cannot stage', async () => {
		const t0 = await fp();
		writeFileSync(abs('src', 'a.txt'), 'worker\n');
		git('add src/a.txt');
		mkdirSync(abs('src', 'nested'), { recursive: true });
		execSync('git init -q', { cwd: abs('src', 'nested') });
		await restoreTree(WS, t0.tree, t0);
		expect(readFileSync(abs('src', 'a.txt'), 'utf8')).toBe('one\n');
		expect(git('diff --cached --name-only')).toBe('');
	});

	it('keeps a pre-existing ignored file the worker force-staged', async () => {
		writeFileSync(abs('.git', 'info', 'exclude'), 'local.cfg\n');
		writeFileSync(abs('local.cfg'), 'mine\n');
		const t0 = await fp();
		git('add -f local.cfg');
		await restoreTree(WS, t0.tree, t0);
		expect(readFileSync(abs('local.cfg'), 'utf8')).toBe('mine\n');
		expect(git('diff --cached --name-only')).toBe('');
	});

	it('removes a tracked, ignored file deleted at capture that the worker wrote again', async () => {
		writeFileSync(abs('cache.cfg'), 'tracked\n');
		git('add cache.cfg');
		git('commit -q -m cfg');
		writeFileSync(abs('.git', 'info', 'exclude'), 'cache.cfg\n');
		rmSync(abs('cache.cfg'));
		const t0 = await fp();
		writeFileSync(abs('cache.cfg'), 'worker\n');
		git('add -f cache.cfg');
		await restoreTree(WS, t0.tree, t0);
		expect(existsSync(abs('cache.cfg'))).toBe(false);
	});

	it('puts back an index flag the worker cleared', async () => {
		git('update-index --skip-worktree src/b.txt');
		const t0 = await fp();
		git('update-index --no-skip-worktree src/b.txt');
		expect(sameFingerprint(t0, await fp())).toBe(false);
		await restoreTree(WS, t0.tree, t0);
		expect(git('ls-files -t src/b.txt').trim()).toBe('S src/b.txt');
	});

	it('keeps a directory that stands where the index still tracks a file', async () => {
		writeFileSync(abs('config'), 'file\n');
		git('add config');
		git('commit -q -m config');
		rmSync(abs('config'));
		mkdirSync(abs('config'));
		writeFileSync(abs('config', 'settings.json'), '{}\n');
		const t0 = await fp();
		writeFileSync(abs('src', 'a.txt'), 'worker\n');
		await restoreTree(WS, t0.tree, t0);
		expect(readFileSync(abs('config', 'settings.json'), 'utf8')).toBe('{}\n');
	});

	it('removes a symlink the worker put where a deleted, ignored file was', async () => {
		writeFileSync(abs('cache.cfg'), 'tracked\n');
		git('add cache.cfg');
		git('commit -q -m cfg');
		writeFileSync(abs('.git', 'info', 'exclude'), 'cache.cfg\n');
		rmSync(abs('cache.cfg'));
		const t0 = await fp();
		symlinkSync('src', abs('cache.cfg'));
		await restoreTree(WS, t0.tree, t0);
		expect(existsSync(abs('cache.cfg'))).toBe(false);
		expect(existsSync(abs('src', 'a.txt'))).toBe(true);
	});

	it('saves the index unchanged by attributes that would filter it', async () => {
		writeFileSync(abs('.git', 'info', 'attributes'), '* filter=mangle\n');
		git('config filter.mangle.clean "tr a-z A-Z"');
		git('config filter.mangle.smudge cat');
		const t0 = await fp();
		writeFileSync(abs('src', 'a.txt'), 'worker\n');
		git('add src/a.txt');
		await restoreTree(WS, t0.tree, t0);
		expect(git('diff --cached --name-only')).toBe('');
	});

	it('refuses to write the index while another git holds its lock', async () => {
		const t0 = await fp();
		writeFileSync(abs('src', 'a.txt'), 'worker\n');
		git('add src/a.txt');
		writeFileSync(abs('.git', 'index.lock'), '');
		try {
			await expect(restoreTree(WS, t0.tree, t0)).rejects.toThrow(/Could not restore/);
		} finally {
			rmSync(abs('.git', 'index.lock'), { force: true });
		}
	});

	it('leaves no lock behind when the saved index cannot be read', async () => {
		const t0 = await fp();
		writeFileSync(abs('src', 'a.txt'), 'worker\n');
		git('add src/a.txt');
		await expect(restoreTree(WS, t0.tree, { ...t0, indexBlob: '0'.repeat(40) })).rejects.toThrow(/Could not restore/);
		expect(existsSync(abs('.git', 'index.lock'))).toBe(false);
	});

	it('throws when it cannot restore', async () => {
		await expect(restoreTree(WS, '0'.repeat(40))).rejects.toThrow(/Could not restore/);
	});
});

describe('changedPaths and diffStat', () => {
	it('describe the difference between two trees', async () => {
		const a = await fp();
		writeFileSync(abs('src', 'a.txt'), 'changed\n');
		writeFileSync(abs('src', 'new.txt'), 'n\n');
		const b = await fp();
		const names = await changedPaths(WS, a.tree, b.tree);
		expect(names).toMatch(/M\tsrc\/a\.txt/);
		expect(names).toMatch(/A\tsrc\/new\.txt/);
		expect(await diffStat(WS, a.tree, b.tree)).toContain('2 files changed');
	});

	it('bound a very large listing', async () => {
		const a = await fp();
		for (let i = 0; i < 400; i++) writeFileSync(abs('src', `generated-file-name-${i}.txt`), 'x\n');
		const b = await fp();
		expect((await changedPaths(WS, a.tree, b.tree)).length).toBeLessThan(2_100);
	});
});

describe('runCheck', () => {
	it('passes a clean command', async () => {
		const r = await runCheck(WS, 'grep -q one src/a.txt');
		expect(r).toMatchObject({ code: 0, timedOut: false, wrote: null });
	});

	it('reports a failing one with its output', async () => {
		const r = await runCheck(WS, 'echo nope >&2; exit 3');
		expect(r.code).toBe(3);
		expect(r.output).toContain('nope');
		expect(r.wrote).toBeNull();
	});

	it('flags and reverts a check that writes a file git would track', async () => {
		writeFileSync(abs('src', 'earlier.txt'), 'keep me\n');
		const r = await runCheck(WS, 'echo hi > src/made.txt && sed -i s/one/uno/ src/a.txt');
		expect(r.wrote).toContain('src/made.txt');
		expect(r.wrote).toContain('src/a.txt');
		expect(existsSync(abs('src', 'made.txt'))).toBe(false);
		expect(readFileSync(abs('src', 'a.txt'), 'utf8')).toBe('one\n');
		expect(readFileSync(abs('src', 'earlier.txt'), 'utf8')).toBe('keep me\n');
	});

	it('allows a check that writes only an ignored path', async () => {
		const r = await runCheck(WS, 'mkdir -p cache && echo x > cache/out && true');
		expect(r.wrote).toBeNull();
		expect(r.code).toBe(0);
	});

	it('flags and reverts a check that commits', async () => {
		writeFileSync(abs('src', 'a.txt'), 'edited\n');
		const headBefore = git('rev-parse HEAD');
		const statusBefore = status();
		const r = await runCheck(WS, 'git add -A && git commit -q -m sneaky');
		expect(r.wrote).toContain('HEAD moved');
		expect(git('rev-parse HEAD')).toBe(headBefore);
		expect(git('symbolic-ref HEAD').trim()).toBe('refs/heads/main');
		expect(readFileSync(abs('src', 'a.txt'), 'utf8')).toBe('edited\n');
		expect(status()).toBe(statusBefore);
	});

	it('removes a file hidden by an ignore rule the command added', async () => {
		// The file is invisible to a fingerprint taken under the command's own
		// .gitignore, so the report names only the rule; the restore puts the
		// rules back before it cleans, which is what removes the file.
		const r = await runCheck(WS, 'echo hidden/ >> .gitignore && mkdir hidden && echo x > hidden/f');
		expect(r.wrote).toContain('.gitignore');
		expect(existsSync(abs('hidden', 'f'))).toBe(false);
		expect(readFileSync(abs('.gitignore'), 'utf8')).toBe('cache/\n');
	});

	it('counts a check that only marks a path with git add -N as a write', async () => {
		writeFileSync(abs('src', 'untracked.txt'), 'u\n');
		const r = await runCheck(WS, 'git add -N src/untracked.txt');
		expect(r.wrote).toContain('staged');
		expect(intents()).toEqual([]);
	});

	it('leaves local edits alone when the check changed only what is staged', async () => {
		git('update-index --assume-unchanged src/b.txt');
		writeFileSync(abs('src', 'b.txt'), 'local edit\n');
		writeFileSync(abs('src', 'u.txt'), 'u\n');
		const r = await runCheck(WS, 'git add -N src/u.txt');
		expect(r.wrote).toContain('staged');
		expect(readFileSync(abs('src', 'b.txt'), 'utf8')).toBe('local edit\n');
		expect(intents()).toEqual([]);
	});

	it('says what it could not undo rather than reporting it reverted', async () => {
		// git clean leaves a nested repository in place.
		await expect(
			runCheck(
				WS,
				'echo nested/ >> .gitignore && mkdir nested && cd nested && git init -q && echo x > f && git add f && git -c user.email=t@t -c user.name=t commit -qm n'
			)
		).rejects.toThrow(/not all of it could be undone[\s\S]*nested/);
	});

	it('refuses to report success when the command removed the git metadata', async () => {
		await expect(runCheck(WS, 'rm -rf .git')).rejects.toThrow(/git metadata/);
	});

	it('keeps the tail of long output and scrubs credentials', async () => {
		const r = await runCheck(
			WS,
			'yes line | head -n 2000; echo "https://x-access-token:abc123@github.com/x/y"; echo END; exit 1'
		);
		expect(r.output.length).toBeLessThanOrEqual(1_502);
		expect(r.output).toContain('END');
		expect(r.output).not.toContain('abc123');
	});

	it('reports a timeout', async () => {
		process.env.TASK_CHECK_TIMEOUT_MS = '500';
		try {
			const r = await runCheck(WS, 'sleep 5');
			expect(r.timedOut).toBe(true);
			expect(r.code).not.toBe(0);
		} finally {
			delete process.env.TASK_CHECK_TIMEOUT_MS;
		}
	});
});
