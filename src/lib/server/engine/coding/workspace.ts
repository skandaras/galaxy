import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join, normalize, resolve, sep } from 'node:path';
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
 * Used by every file tool.
 */
export function safeJoin(workspaceRel: string, relPath: string): string {
	const base = resolve(workspaceAbs(workspaceRel));
	const target = resolve(base, normalize(relPath));
	if (target !== base && !target.startsWith(base + sep)) {
		throw new Error(`Path escapes the workspace: ${relPath}`);
	}
	return target;
}

/** Inject the GitHub token for github.com HTTPS remotes; other URLs pass through. */
export function authenticatedUrl(repoUrl: string, token: string | undefined): string {
	if (!token) return repoUrl;
	const m = repoUrl.match(/^https:\/\/github\.com\/(.+)$/);
	return m ? `https://x-access-token:${token}@github.com/${m[1]}` : repoUrl;
}

/** Remove any credential that may appear in command output before storing/streaming. */
export function scrubSecrets(text: string): string {
	return text.replace(/x-access-token:[^@\s]+@/g, 'x-access-token:***@');
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
	const url = authenticatedUrl(repoUrl, githubToken());
	mkdirSync(join(dataDir, WORKSPACES_REL), { recursive: true });

	const clone = await run(executor, WORKSPACES_REL, `mkdir -p ${id} && git clone ${shellQuote(url)} ${id}`, 300_000);
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
