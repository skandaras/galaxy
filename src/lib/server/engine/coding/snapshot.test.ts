import { beforeEach, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
