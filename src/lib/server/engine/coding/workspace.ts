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
			`[${name} — this repository's own instructions. Follow them; they outrank your general habits.]\n${slice}${
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

/** Clone the repo into a fresh workspace and create the session's work branch. */
export async function createWorkspace(repoUrl: string): Promise<CreatedWorkspace> {
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
	const baseBranch = head.stdout.trim() || 'main';
	const workBranch = `galaxy/session-${id}`;
	const branch = await run(executor, workspaceRel, `git checkout -b ${shellQuote(workBranch)}`);
	if (branch.code !== 0) {
		throw new Error(`Branch creation failed: ${scrubSecrets(branch.stderr)}`);
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
