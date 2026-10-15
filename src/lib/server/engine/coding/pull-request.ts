import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { codeSessions } from '$lib/server/db/schema';
import { getExecutor } from './executor';
import { runRepoHooks, type HookRun } from './hooks';
import { gitAuthArgs, githubToken, scrubSecrets } from './workspace';
import { ADMIN_PATHS } from '$lib/admin-sections';

/**
 * Opening the pull request, which is where a coding session was stopping one
 * step short.
 *
 * The agent could commit and push, and then the work sat on a branch that
 * someone had to go and find. Both Claude Code and Conductor close this loop,
 * and everything needed for it was already here: the token is stored, the REST
 * API is already called to list repositories, and the session knows its own
 * base and work branch.
 */

export interface PullRequestTarget {
	/** The session's chat, so the pre-push checks this runs reach the session panel. */
	chatId?: string;
	repoUrl: string;
	workspaceRel: string;
	baseBranch: string;
	workBranch: string;
}

export interface PullRequestResult {
	url: string;
	number: number;
	/** True when the PR was already open and this call only found it. */
	existing: boolean;
	/** The pre-push checks this call ran, for the caller's event. */
	hooks: HookRun[];
}

/** A GitHub owner or repository name, as GitHub itself allows them. */
const SLUG_SEGMENT = /^[A-Za-z0-9_.-]+$/;

/**
 * `owner/repo` for a github.com remote, or null for anywhere else.
 *
 * Read from a parsed URL and rebuilt from its two path segments. This was a
 * regex whose repository group took any run of non-slash characters, so
 * `https://github.com/o/r?access_token=…` came back with the token inside the
 * slug, which the session panel would then have put in a link.
 */
export function githubRepoSlug(repoUrl: string): string | null {
	let url: URL;
	try {
		url = new URL(repoUrl.trim());
	} catch {
		return null;
	}
	if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port) return null;
	if (url.username || url.password || url.search || url.hash) return null;
	const parts = url.pathname.split('/').filter(Boolean);
	if (parts.length !== 2) return null;
	const [owner, repo] = [parts[0], parts[1].replace(/\.git$/, '')];
	return SLUG_SEGMENT.test(owner) && SLUG_SEGMENT.test(repo) ? `${owner}/${repo}` : null;
}

async function api(
	slug: string,
	path: string,
	token: string,
	init?: RequestInit
): Promise<Response> {
	return fetch(`https://api.github.com/repos/${slug}${path}`, {
		...init,
		headers: {
			authorization: `Bearer ${token}`,
			accept: 'application/vnd.github+json',
			'content-type': 'application/json',
			'user-agent': 'galaxy',
			...init?.headers
		},
		signal: AbortSignal.timeout(20_000)
	});
}

export async function openPullRequest(
	target: PullRequestTarget,
	opts: { title: string; body?: string }
): Promise<PullRequestResult> {
	const slug = githubRepoSlug(target.repoUrl);
	if (!slug) {
		throw new Error(
			`Pull requests are only supported for github.com remotes; this session is on ${target.repoUrl}`
		);
	}
	const token = githubToken();
	if (!token) throw new Error(`No GitHub token configured (${ADMIN_PATHS.github})`);
	const title = opts.title.trim();
	if (!title) throw new Error('title is required');

	// Push first, always: GitHub refuses a pull request from a branch it has
	// never seen, and "commit, push, open" is three chances to forget the middle
	// one. Pushing an already-pushed branch is a no-op.
	//
	// Gated here rather than in the tool, because the session header's button
	// reaches this too, and a push from a button is still a push.
	const hooks = await runRepoHooks('pre_push', target);
	const push = await getExecutor().exec(
		`git ${gitAuthArgs(target.repoUrl)} push -u origin HEAD`,
		{ cwdRel: target.workspaceRel, timeoutMs: 120_000 }
	);
	if (push.code !== 0) throw new Error(`Push failed: ${scrubSecrets(push.stderr || push.stdout)}`);

	const res = await api(slug, '/pulls', token, {
		method: 'POST',
		body: JSON.stringify({
			title,
			body: opts.body?.trim() || undefined,
			head: target.workBranch,
			base: target.baseBranch
		})
	});
	if (res.ok) {
		const pr = await res.json();
		return { url: pr.html_url, number: pr.number, existing: false, hooks };
	}

	// 422 is what GitHub says both for "there is already one open for this
	// branch" and for a genuinely bad request, so look before reporting: a
	// second attempt on a session that already has a PR should hand back the
	// PR, not an error the agent then tries to work around.
	if (res.status === 422) {
		const owner = slug.split('/')[0];
		const found = await api(
			slug,
			`/pulls?state=open&head=${encodeURIComponent(`${owner}:${target.workBranch}`)}`,
			token
		);
		const rows = found.ok ? await found.json() : [];
		if (Array.isArray(rows) && rows.length) {
			return { url: rows[0].html_url, number: rows[0].number, existing: true, hooks };
		}
	}
	throw new Error(`GitHub refused the pull request (${res.status}): ${(await res.text()).slice(0, 300)}`);
}

/** Remember the session's pull request, so the page can link it on any visit. */
export function recordPullRequest(chatId: string, url: string): void {
	db.update(codeSessions).set({ prUrl: url }).where(eq(codeSessions.chatId, chatId)).run();
}
