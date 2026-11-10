import { taskCheckTimeoutMs } from '../limits';
import { getExecutor } from './executor';
import { scrubSecrets, shellQuote } from './workspace';

/**
 * Seeing what a command did to the work tree, and undoing it.
 *
 * A task's check is a shell string written by the orchestrator, which has no
 * tool that writes code. Without this, the check was the way round that:
 * `sed -i ... && test -f x` writes, then passes. So every check is bracketed by
 * a fingerprint, and a check that changed anything is refused and reverted.
 *
 * The same fingerprint is the "start of task" a failed worker run is rolled
 * back to. A plain `git stash` or `git checkout .` cannot be that: neither
 * knows about files an earlier task created and nobody has committed yet, and
 * losing those is losing the orchestrator's work.
 */

export interface Fingerprint {
	/** Tree object of everything in the work tree that git would track. */
	tree: string;
	/** Commit HEAD points at; empty before the first commit. */
	head: string;
	/** Branch HEAD names; empty when detached. */
	ref: string;
}

const MAX_CHANGED_CHARS = 2_000;
const MAX_STAT_CHARS = 3_000;
const MAX_OUTPUT_CHARS = 1_500;
/** Exit code the scripts below use for "not a work tree", apart from a git failure. */
const NOT_A_REPO = 3;

/**
 * Run git against a private copy of the index.
 *
 * Staging into the real index would show up in `git status`, and in what the
 * next `git_commit` picks up; a copy leaves it exactly as the person had it.
 * Ignored files never enter the copy, so a cache or node_modules written by a
 * check does not read as a change. Before the first commit there is no index
 * file yet, and an empty one is not a valid index, so the copy is skipped.
 */
const WITH_TEMP_INDEX = `
gd=$(git rev-parse --git-dir 2>/dev/null) && [ "$(git rev-parse --is-inside-work-tree 2>/dev/null)" = true ] || exit ${NOT_A_REPO}
tmp=$(mktemp) || exit 1
trap 'rm -f "$tmp"' EXIT
rm -f "$tmp"
if [ -f "$gd/index" ]; then cp "$gd/index" "$tmp" || exit 1; fi
export GIT_INDEX_FILE="$tmp"
`;

export async function treeFingerprint(workspaceRel: string): Promise<Fingerprint | null> {
	const res = await getExecutor().exec(
		`${WITH_TEMP_INDEX}
git add -A || exit 1
tree=$(git write-tree) || exit 1
echo "tree $tree"
echo "head $(git rev-parse -q --verify HEAD 2>/dev/null)"
echo "ref $(git symbolic-ref -q HEAD 2>/dev/null)"
`,
		{ cwdRel: workspaceRel, timeoutMs: 60_000 }
	);
	if (res.code === NOT_A_REPO) return null;
	if (res.code !== 0) {
		throw new Error(`Could not read the work tree: ${scrubSecrets(res.stderr || res.stdout).trim()}`);
	}
	const field = (name: string) =>
		res.stdout.split('\n').find((l) => l.startsWith(`${name} `))?.slice(name.length + 1).trim() ?? '';
	const tree = field('tree');
	if (!tree) throw new Error('Could not read the work tree: git wrote no tree');
	return { tree, head: field('head'), ref: field('ref') };
}

export function sameFingerprint(a: Fingerprint, b: Fingerprint): boolean {
	return a.tree === b.tree && a.head === b.head && a.ref === b.ref;
}

/**
 * Make the work tree hold exactly the files in `tree`.
 *
 * `git clean -fd` runs against the real index, since it is what tells tracked
 * files from untracked ones; with a temporary index in its place it would see
 * nothing as tracked. Without -x it takes out what a worker created and leaves
 * ignored files, which are expensive to rebuild (node_modules) and which the
 * fingerprint never counted. The checkout then goes through a temporary index,
 * so the real one is not rewritten: `read-tree` into it would make every file
 * an earlier task left uncommitted look staged, and `git status` would no
 * longer say what it said when the tree was captured.
 *
 * Two gaps the clean leaves, because it only removes untracked paths: a worker
 * that ran `git add` on a new file made it tracked, and one that recreated a
 * file that was deleted at capture made it tracked too. Both are in the real
 * index and not in `tree`, so they are deleted here and reset in the index to
 * what HEAD has (which is nothing for a new file, and the entry that makes it
 * show as deleted again for the other). A worker staging an edit to a file
 * that was already tracked is not undone; the index keeps that hunk staged.
 */
export async function restoreTree(workspaceRel: string, tree: string): Promise<void> {
	const t = shellQuote(tree);
	const res = await getExecutor().exec(
		`gd=$(git rev-parse --git-dir) || exit 1
git clean -fdq || exit 1
gone=$(mktemp) || exit 1
tmp=$(mktemp) || exit 1
trap 'rm -f "$tmp" "$gone"' EXIT
rm -f "$tmp"
if [ -f "$gd/index" ]; then
	git diff-index --cached --name-only --diff-filter=A -z ${t} > "$gone" || exit 1
fi
if [ -s "$gone" ]; then
	xargs -0 rm -f -- < "$gone" || exit 1
	xargs -0 git reset -q -- < "$gone" || exit 1
fi
GIT_INDEX_FILE="$tmp" git read-tree ${t} || exit 1
GIT_INDEX_FILE="$tmp" git checkout-index -a -f || exit 1
`,
		{ cwdRel: workspaceRel, timeoutMs: 60_000 }
	);
	if (res.code !== 0) {
		throw new Error(`Could not restore the work tree: ${scrubSecrets(res.stderr || res.stdout).trim()}`);
	}
}

async function diffOutput(
	workspaceRel: string,
	flag: string,
	fromTree: string,
	toTree: string,
	max: number
): Promise<string> {
	const res = await getExecutor().exec(
		`git diff --no-color --no-ext-diff ${flag} ${shellQuote(fromTree)} ${shellQuote(toTree)}`,
		{ cwdRel: workspaceRel, timeoutMs: 30_000 }
	);
	const text = scrubSecrets(res.stdout).trim();
	return text.length > max ? `${text.slice(0, max)}\n…(more files changed)` : text;
}

export function changedPaths(workspaceRel: string, fromTree: string, toTree: string): Promise<string> {
	return diffOutput(workspaceRel, '--name-status', fromTree, toTree, MAX_CHANGED_CHARS);
}

export function diffStat(workspaceRel: string, fromTree: string, toTree: string): Promise<string> {
	return diffOutput(workspaceRel, '--stat=100', fromTree, toTree, MAX_STAT_CHARS);
}

/** Put HEAD and its branch back where `before` had them. */
export async function restoreHead(workspaceRel: string, before: Fingerprint): Promise<void> {
	const ref = before.ref ? shellQuote(before.ref) : '';
	const head = shellQuote(before.head);
	// The branch is moved back before HEAD is pointed at it again, so a check
	// that switched branches does not leave the old one at the new commit. The
	// mixed reset at the end is because a commit made by the check also rewrote
	// the index to match itself.
	const script = before.ref
		? [
				before.head ? `git update-ref ${ref} ${head}` : `git update-ref -d ${ref}`,
				`git symbolic-ref HEAD ${ref}`,
				'git reset -q'
			]
		: [`git update-ref --no-deref HEAD ${head}`, 'git reset -q'];
	const res = await getExecutor().exec(script.join(' && '), {
		cwdRel: workspaceRel,
		timeoutMs: 30_000
	});
	if (res.code !== 0) {
		throw new Error(`Could not put HEAD back: ${scrubSecrets(res.stderr || res.stdout).trim()}`);
	}
}

export interface CheckResult {
	code: number;
	/** stdout and stderr, scrubbed, the last 1500 characters. */
	output: string;
	timedOut: boolean;
	/** What the command changed in the work tree or in HEAD, already reverted; null when it changed nothing. */
	wrote: string | null;
}

export async function runCheck(workspaceRel: string, command: string): Promise<CheckResult> {
	const before = await treeFingerprint(workspaceRel);
	if (!before) throw new Error('The workspace is not a git work tree, so a check cannot be run safely.');

	const timeoutMs = taskCheckTimeoutMs();
	const started = Date.now();
	const res = await getExecutor().exec(command, { cwdRel: workspaceRel, timeoutMs });
	// The docker executor reports 124; the local one reports whatever the
	// killed process left, which is 1, so the clock is the second witness.
	const timedOut = res.code === 124 || (res.code !== 0 && Date.now() - started >= timeoutMs - 250);

	const after = await treeFingerprint(workspaceRel);
	let wrote: string | null = null;
	if (after && !sameFingerprint(before, after)) {
		const lines: string[] = [];
		if (before.head !== after.head || before.ref !== after.ref) {
			lines.push('HEAD moved: the command made a commit or switched branch.');
		}
		if (before.tree !== after.tree) lines.push(await changedPaths(workspaceRel, before.tree, after.tree));
		wrote = lines.join('\n');
		if (before.head !== after.head || before.ref !== after.ref) await restoreHead(workspaceRel, before);
		await restoreTree(workspaceRel, before.tree);
	}

	const combined = scrubSecrets([res.stdout, res.stderr].filter(Boolean).join('\n')).trim();
	return {
		code: res.code,
		output: combined.length > MAX_OUTPUT_CHARS ? `…${combined.slice(-MAX_OUTPUT_CHARS)}` : combined,
		timedOut,
		wrote
	};
}
