import { beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir, runMigrations } from '$lib/server/db';
import { getExecutor } from './executor';
import { HOOKS_FILE, HookFailure, parseHooks, readRepoHooks, runRepoHooks } from './hooks';
import { codingTools, type CodingToolContext } from './tools';

const ROOT = 'workspaces/hooks-test';
const sh = async (cwdRel: string, command: string) => {
	const res = await getExecutor().exec(command, { cwdRel, timeoutMs: 60_000 });
	if (res.code !== 0) throw new Error(`${command}: ${res.stderr || res.stdout}`);
	return res.stdout;
};
const GIT_ID = 'git config user.email t@t && git config user.name t';

/** A bare origin whose main branch carries `hooks`, and a session clone of it. */
async function fixture(name: string, hooks: object | null): Promise<CodingToolContext> {
	const dir = `${ROOT}/${name}`;
	rmSync(join(dataDir, dir), { recursive: true, force: true });
	mkdirSync(join(dataDir, dir, 'seed'), { recursive: true });
	await sh(dir, 'git init -q --bare --initial-branch=main origin.git');
	await sh(`${dir}/seed`, `git init -q --initial-branch=main && ${GIT_ID}`);
	writeFileSync(join(dataDir, dir, 'seed', 'README.md'), '# fixture\n');
	if (hooks) {
		mkdirSync(join(dataDir, dir, 'seed', '.galaxy'));
		writeFileSync(join(dataDir, dir, 'seed', HOOKS_FILE), JSON.stringify(hooks));
	}
	await sh(
		`${dir}/seed`,
		'git add -A && git commit -qm init && git remote add origin ../origin.git && git push -q origin main'
	);
	await sh(dir, 'git clone -q origin.git ws');
	await sh(`${dir}/ws`, `${GIT_ID} && git checkout -q -b galaxy/session-test`);
	return {
		chatId: `hooks-test-${name}`,
		workspaceRel: `${dir}/ws`,
		mode: 'implement',
		repoUrl: join(dataDir, dir, 'origin.git'),
		baseBranch: 'main',
		workBranch: 'galaxy/session-test'
	};
}

const tool = (ctx: CodingToolContext, name: string) => {
	const found = codingTools(ctx).find((t) => t.def.name === name);
	if (!found) throw new Error(`no such tool: ${name}`);
	return found;
};

/** A gate that passes only once the work tree holds a file named `ok`. */
const MARKER_GATE = {
	pre_commit: ['true'],
	pre_push: [{ run: "test -f ok || (echo 'the marker is missing'; exit 3)", timeoutSeconds: 30 }]
};

beforeAll(() => {
	runMigrations();
});

describe('parseHooks', () => {
	it('reads commands as strings or as objects with a timeout', () => {
		const hooks = parseHooks(
			JSON.stringify({
				pre_commit: ['npm run lint', '  '],
				pre_push: [{ run: 'npm test', timeoutSeconds: 120 }, { run: 'x', timeoutSeconds: 99_999 }]
			})
		);
		expect(hooks.pre_commit).toEqual([{ run: 'npm run lint', timeoutSeconds: 600 }]);
		expect(hooks.pre_push).toEqual([
			{ run: 'npm test', timeoutSeconds: 120 },
			{ run: 'x', timeoutSeconds: 1_800 }
		]);
	});

	it('refuses a broken file rather than reading it as no checks', () => {
		expect(() => parseHooks('{ pre_push: [')).toThrow(/not valid JSON/);
	});
});

describe('repository hooks', () => {
	it('mean nothing when the base branch has no hooks file', async () => {
		const ctx = await fixture('none', null);
		expect(await readRepoHooks(ctx)).toEqual({ pre_commit: [], pre_push: [] });
		expect(await runRepoHooks('pre_push', ctx)).toEqual([]);
	});

	it('refuse a push with the failing output and report the run', async () => {
		const ctx = await fixture('refuse', MARKER_GATE);
		const reports: Record<string, unknown>[] = [];
		const push = tool(ctx, 'git_push').execute({}, (m) => reports.push(m));
		await expect(push).rejects.toThrow(/pre_push check .* failed \(exit 3\)[\s\S]*the marker is missing/);
		expect(reports.at(-1)?.hooks).toMatchObject([{ stage: 'pre_push', code: 3 }]);
		// Nothing reached the remote.
		const remote = await getExecutor().exec('git ls-remote --heads origin galaxy/session-test', {
			cwdRel: ctx.workspaceRel
		});
		expect(remote.stdout.trim()).toBe('');
	});

	it('let the push through once the check passes', async () => {
		const ctx = await fixture('pass', MARKER_GATE);
		writeFileSync(join(dataDir, ctx.workspaceRel, 'ok'), '');
		await tool(ctx, 'git_commit').execute({ message: 'add marker' });
		const reports: Record<string, unknown>[] = [];
		await tool(ctx, 'git_push').execute({}, (m) => reports.push(m));
		expect(reports.at(-1)?.hooks).toMatchObject([{ stage: 'pre_push', code: 0 }]);
		const remote = await sh(ctx.workspaceRel, 'git ls-remote --heads origin galaxy/session-test');
		expect(remote).toContain('galaxy/session-test');
	});

	it('are read from the base branch, so a session cannot edit its own gate', async () => {
		const ctx = await fixture('tamper', MARKER_GATE);
		writeFileSync(
			join(dataDir, ctx.workspaceRel, HOOKS_FILE),
			JSON.stringify({ pre_commit: [], pre_push: [] })
		);
		await tool(ctx, 'git_commit').execute({ message: 'loosen the gate' });
		await expect(tool(ctx, 'git_push').execute({})).rejects.toThrow(HookFailure);
	});

	it('refuse a commit when the pre-commit check fails, leaving nothing committed', async () => {
		const ctx = await fixture('commit', { pre_commit: ['exit 1'], pre_push: [] });
		writeFileSync(join(dataDir, ctx.workspaceRel, 'change.txt'), 'x');
		await expect(tool(ctx, 'git_commit').execute({ message: 'nope' })).rejects.toThrow(
			/pre_commit check `exit 1` failed/
		);
		expect(await sh(ctx.workspaceRel, 'git status --porcelain')).toContain('change.txt');
	});

	it('do not run the suite twice for a clean HEAD that already passed', async () => {
		const ctx = await fixture('cache', MARKER_GATE);
		writeFileSync(join(dataDir, ctx.workspaceRel, 'ok'), '');
		await tool(ctx, 'git_commit').execute({ message: 'add marker' });
		expect(await runRepoHooks('pre_push', ctx)).toHaveLength(1);
		expect(await runRepoHooks('pre_push', ctx)).toEqual([]);
		// A new commit is new work, and is checked again.
		writeFileSync(join(dataDir, ctx.workspaceRel, 'more.txt'), 'x');
		await tool(ctx, 'git_commit').execute({ message: 'more' });
		expect(await runRepoHooks('pre_push', ctx)).toHaveLength(1);
	});
});
