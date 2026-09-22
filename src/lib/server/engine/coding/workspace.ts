import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { dataDir } from '$lib/server/db';
import { decryptSecret } from '$lib/server/crypto';
import { getSetting, type GithubSettings } from '$lib/server/settings';
import { getExecutor, type ExecResult } from './executor';

const WORKSPACES_REL = 'workspaces';

export function githubToken(): string | undefined {
	const cfg = getSetting<GithubSettings>('github', {});
	return cfg.tokenEnc ? decryptSecret(cfg.tokenEnc) : undefined;
}

/** Absolute path of a workspace on the app's filesystem. */
export function workspaceAbs(workspaceRel: string): string {
	return join(dataDir, workspaceRel);
}

/**
 * Resolve a repo-relative path inside the workspace, rejecting escapes.
 * Used by every file tool. Beyond the lexical check, the deepest existing
 * ancestor is realpath'd so a symlink planted inside the workspace (e.g. via
 * the bash tool) cannot redirect reads/writes outside it.
 */
export function safeJoin(workspaceRel: string, relPath: string): string {
	const base = realpathSync(resolve(workspaceAbs(workspaceRel)));
	const target = resolve(base, normalize(relPath));
	if (target !== base && !target.startsWith(base + sep)) {
		throw new Error(`Path escapes the workspace: ${relPath}`);
	}
	let probe = target;
	while (!existsSync(probe)) {
		const parent = dirname(probe);
		if (parent === probe) break;
		probe = parent;
	}
	const real = realpathSync(probe);
	if (real !== base && !real.startsWith(base + sep)) {
		throw new Error(`Path escapes the workspace via symlink: ${relPath}`);
	}
	return target;
}

/** Inject the GitHub token for github.com HTTPS remotes; other URLs pass through. */
export function authenticatedUrl(repoUrl: string, token: string | undefined): string {
	if (!token) return repoUrl;
	const m = repoUrl.match(/^https:\/\/github\.com\/(.+)$/);
	return m ? `https://x-access-token:${token}@github.com/${m[1]}` : repoUrl;
}

/**
 * Per-invocation git auth: `-c http.extraheader=…` for github.com remotes.
 * The token is never written to .git/config or any file in the workspace,
 * so the agent's read_file / `git remote -v` cannot recover it.
 */
export function gitAuthArgs(repoUrl: string, token = githubToken()): string {
	if (!token || !/^https:\/\/github\.com\//.test(repoUrl)) return '';
	const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
	return `-c ${shellQuote(`http.extraheader=AUTHORIZATION: basic ${basic}`)}`;
}

/** Remove any credential that may appear in command output before storing/streaming. */
export function scrubSecrets(text: string): string {
	return text
		.replace(/x-access-token:[^@\s]+@/g, 'x-access-token:***@')
		.replace(/AUTHORIZATION: basic [A-Za-z0-9+/=]+/gi, 'AUTHORIZATION: basic ***');
}

/**
 * Repo-level agent instructions, the ones a contributor is expected to read.
 *
 * PLAN.md has always said the platform's own system prompts "sit above
 * repo-level AGENTS.md/CLAUDE.md-style files, which the coding agent still
 * reads inside each repo" — and nothing read them, so the agent rediscovered
 * each repository's conventions from scratch every session, or ignored them.
 *
 * AGENTS.md first because it is the vendor-neutral name and this platform is
 * deliberately model-agnostic; CLAUDE.md is included too, since plenty of
 * repositories carry only that one. Identical content (the two are often the
 * same file linked twice) is not repeated.
 */
export const REPO_INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md'] as const;

/** Total characters of repo instructions folded into the system prompt. */
const MAX_INSTRUCTION_CHARS = 8_000;

export function repoInstructions(workspaceRel: string): string {
	const seen = new Set<string>();
	const blocks: string[] = [];
	let budget = MAX_INSTRUCTION_CHARS;
	for (const name of REPO_INSTRUCTION_FILES) {
		if (budget <= 0) break;
		let body: string;
		try {
			body = readFileSync(safeJoin(workspaceRel, name), 'utf8').trim();
		} catch {
			continue; // absent, unreadable, or outside the workspace — all the same here
		}
		if (!body || seen.has(body)) continue;
		seen.add(body);
		const slice = body.slice(0, budget);
		budget -= slice.length;
		blocks.push(
			`[${name}: this repository's own instructions. Follow them; they outrank your general habits.]\n${slice}${
				slice.length < body.length ? '\n…(truncated)' : ''
			}`
		);
	}
	return blocks.length ? `\n\n${blocks.join('\n\n')}` : '';
}

export interface CreatedWorkspace {
	workspaceRel: string;
	baseBranch: string;
	workBranch: string;
}

/**
 * Clone the repo into a fresh workspace and create the session's work branch.
 *
 * `from` cuts the work branch off a branch other than the remote's default, and
 * reports it as the base — which is what makes a session's diff and its later
 * merge target the same thing. A branch that is not on the remote yet is not an
 * error: Forge's integration branch does not exist until the first green task
 * pushes it, and every clone before that legitimately starts from the default
 * head.
 */
export async function createWorkspace(
	repoUrl: string,
	opts: { from?: string } = {}
): Promise<CreatedWorkspace> {
	const executor = getExecutor();
	const id = randomUUID().slice(0, 8);
	const workspaceRel = `${WORKSPACES_REL}/${id}`;
	mkdirSync(join(dataDir, WORKSPACES_REL), { recursive: true });

	// Clean URL + per-invocation auth header: the token never lands on disk.
	const clone = await run(
		executor,
		WORKSPACES_REL,
		`mkdir -p ${id} && git ${gitAuthArgs(repoUrl)} clone ${shellQuote(repoUrl)} ${id}`,
		300_000
	);
	if (clone.code !== 0) {
		rmSync(workspaceAbs(workspaceRel), { recursive: true, force: true });
		throw new Error(`Clone failed: ${scrubSecrets(clone.stderr || clone.stdout)}`);
	}

	const head = await run(executor, workspaceRel, 'git rev-parse --abbrev-ref HEAD');
	let baseBranch = head.stdout.trim() || 'main';
	const workBranch = `galaxy/session-${id}`;

	if (opts.from && opts.from !== baseBranch && (await remoteHas(workspaceRel, opts.from))) {
		const start = await run(
			executor,
			workspaceRel,
			`git checkout -B ${shellQuote(workBranch)} ${shellQuote(`origin/${opts.from}`)}`
		);
		if (start.code !== 0) {
			throw new Error(`Could not start from ${opts.from}: ${scrubSecrets(start.stderr)}`);
		}
		baseBranch = opts.from;
	} else {
		const branch = await run(executor, workspaceRel, `git checkout -b ${shellQuote(workBranch)}`);
		if (branch.code !== 0) {
			throw new Error(`Branch creation failed: ${scrubSecrets(branch.stderr)}`);
		}
	}
	await run(
		executor,
		workspaceRel,
		`git config user.email galaxy@localhost && git config user.name Galaxy`
	);
	return { workspaceRel, baseBranch, workBranch };
}

export function destroyWorkspace(workspaceRel: string): void {
	if (!workspaceRel.startsWith(`${WORKSPACES_REL}/`)) return;
	rmSync(workspaceAbs(workspaceRel), { recursive: true, force: true });
}

/** Whether the remote carries this branch. Used to decide where to start from. */
async function remoteHas(workspaceRel: string, branch: string): Promise<boolean> {
	const probe = await run(
		getExecutor(),
		workspaceRel,
		`git rev-parse --verify --quiet ${shellQuote(`refs/remotes/origin/${branch}`)}`
	);
	return probe.code === 0;
}

export interface MergeResult {
	ok: boolean;
	/** Why it did not merge, or what it pushed. Already scrubbed. */
	output: string;
}

/**
 * Merge a branch into `target` and push the result.
 *
 * Forge's integration branch is why this exists: a task that goes green has to
 * land somewhere the next task can clone from, and a task that goes red must
 * leave that branch exactly as it was. Nothing else in the codebase merges, so
 * the whole sequence — fetch, check out, merge, push — lives here rather than
 * as shell strings in a driver.
 *
 * A conflict comes back as `ok: false`, not a throw. A task whose merge
 * conflicts parks like a task whose tests failed; it is an outcome, and the
 * caller already knows what to do with one.
 */
export async function mergeIntoBranch(
	workspaceRel: string,
	repoUrl: string,
	opts: { target: string; source: string; baseBranch: string }
): Promise<MergeResult> {
	const executor = getExecutor();
	const auth = gitAuthArgs(repoUrl);
	const target = shellQuote(opts.target);

	// Whatever the remote has now, not what it had when this workspace was
	// cloned — another task may have landed in between.
	await run(executor, workspaceRel, `git ${auth} fetch origin`, 120_000);

	// The first task of an epic finds no integration branch and starts it from
	// the base; every later one continues the branch that is already there.
	const start = (await remoteHas(workspaceRel, opts.target))
		? `origin/${opts.target}`
		: `origin/${opts.baseBranch}`;
	const checkout = await run(
		executor,
		workspaceRel,
		`git checkout -B ${target} ${shellQuote(start)}`
	);
	if (checkout.code !== 0) {
		return { ok: false, output: scrubSecrets(checkout.stderr || checkout.stdout) };
	}

	// --no-ff so the branch reads as a sequence of tasks rather than one flat
	// line of commits nobody can attribute.
	const merge = await run(
		executor,
		workspaceRel,
		`git merge --no-ff --no-edit ${shellQuote(opts.source)}`,
		120_000
	);
	if (merge.code !== 0) {
		// Leave the tree as it was found. A half-merged workspace is the one state
		// from which nothing sensible can be done next.
		await run(executor, workspaceRel, 'git merge --abort');
		return { ok: false, output: scrubSecrets(merge.stdout || merge.stderr) };
	}

	const push = await run(
		executor,
		workspaceRel,
		`git ${auth} push -u origin ${target}`,
		120_000
	);
	if (push.code !== 0) {
		return { ok: false, output: scrubSecrets(push.stderr || push.stdout) };
	}
	return { ok: true, output: scrubSecrets(merge.stdout) };
}

async function run(
	executor: ReturnType<typeof getExecutor>,
	cwdRel: string,
	command: string,
	timeoutMs?: number
): Promise<ExecResult> {
	const res = await executor.exec(command, { cwdRel, timeoutMs });
	return {
		...res,
		stdout: scrubSecrets(res.stdout),
		stderr: scrubSecrets(res.stderr)
	};
}

export function shellQuote(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}
