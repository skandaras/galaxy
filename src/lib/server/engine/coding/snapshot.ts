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
	/**
	 * What is staged: a hash of `git ls-files -s`, empty when there is no index
	 * file yet. Compared, never restored from.
	 */
	index: string;
	/**
	 * The index file itself, stored as a blob so a rollback can put it back
	 * byte for byte, flags and intent-to-add entries included, which a tree
	 * cannot hold. Empty when there is no index file. Unreachable, so git's own
	 * gc removes it in time.
	 */
	indexBlob: string;
}

const MAX_CHANGED_CHARS = 2_000;
const MAX_STAT_CHARS = 3_000;
const MAX_OUTPUT_CHARS = 1_500;
/** Exit code the scripts below use for "not a work tree", apart from a git failure. */
const NOT_A_REPO = 3;

/** Command output is attacker-reachable (test names, file names, file contents), so it is quoted as data. */
const OUTPUT_BEGIN = '--- BEGIN COMMAND OUTPUT ---';
const OUTPUT_END = '--- END COMMAND OUTPUT ---';
export function fenced(text: string): string {
	const safe = text.replaceAll(OUTPUT_END, '--- END COMMAND OUTPUT (quoted) ---').replaceAll(OUTPUT_BEGIN, '--- BEGIN COMMAND OUTPUT (quoted) ---');
	return `${OUTPUT_BEGIN}\n${safe || '(no output)'}\n${OUTPUT_END}`;
}

/**
 * What is staged, without the stat data that changes whenever git looks.
 *
 * `ls-files -s` alone cannot tell an intent-to-add entry for an empty file
 * from the same file fully staged: mode, object and path all match. Against
 * HEAD, only the staged one shows as added, so that diff goes in too. So do
 * the per-path flags `ls-files -v` shows (skip-worktree, assume-unchanged),
 * which hide later edits from git and are otherwise invisible here. Each read
 * has to succeed: hashing whatever a failed one left would give two different
 * states the same digest.
 */
const STAGED_DIGEST_FN = `staged_digest() {
	f=$(mktemp) || return 1
	{ git ls-files -s -z && printf 'cached\\0' && git diff --cached -O/dev/null --no-ext-diff --no-renames --name-status -z && printf 'flags\\0' && git ls-files -v -z; } > "$f" || { rm -f "$f"; return 1; }
	git hash-object --stdin < "$f"; s=$?; rm -f "$f"; return $s
}`;

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
${STAGED_DIGEST_FN}
if [ -f "$gd/index" ]; then
	# --no-filters: an attribute matching the temp file's name must not
	# transform the bytes written back over the real index.
	iblob=$(git hash-object -w --no-filters "$tmp") || exit 1
	isum=$(staged_digest) || exit 1
else
	iblob=; isum=
fi
git add -A || exit 1
tree=$(git write-tree) || exit 1
echo "tree $tree"
echo "head $(git rev-parse -q --verify HEAD 2>/dev/null)"
echo "ref $(git symbolic-ref -q HEAD 2>/dev/null)"
echo "index $isum"
echo "iblob $iblob"
`,
		{ cwdRel: workspaceRel, timeoutMs: 60_000 }
	);
	if (res.code === NOT_A_REPO) return null;
	if (res.code !== 0) {
		throw new Error(`Could not read the work tree. Git said, as data:\n${fenced(scrubSecrets(res.stderr || res.stdout).trim())}`);
	}
	const field = (name: string) =>
		res.stdout.split('\n').find((l) => l.startsWith(`${name} `))?.slice(name.length + 1).trim() ?? '';
	const tree = field('tree');
	if (!tree) throw new Error('Could not read the work tree: git wrote no tree');
	// Both read from the copy before `git add -A`, while it still matches the
	// real index, so what is staged is captured without touching the real file.
	return { tree, head: field('head'), ref: field('ref'), index: field('index'), indexBlob: field('iblob') };
}

export function sameFingerprint(a: Fingerprint, b: Fingerprint): boolean {
	return a.tree === b.tree && a.head === b.head && a.ref === b.ref && a.index === b.index;
}

/**
 * Make the work tree hold exactly the files in `tree`, and the index what it
 * held when `staged` was captured.
 *
 * The clean runs against a temporary index holding `tree`, so it removes every
 * file that is neither in the tree nor ignored. It used to run against the real
 * index, where a path deleted at capture is still tracked: a worker that took
 * it out of the index and wrote it again left a file the clean skipped and the
 * checkout never removed. Without -x the clean leaves ignored files, which are
 * expensive to rebuild (node_modules) and which the fingerprint never counted.
 * The checkout goes through the same temporary index, so the real one is not
 * rewritten from the tree: that would make every file an earlier task left
 * uncommitted look staged.
 *
 * The ignore rules are put back before the clean. It used to run under the
 * worker's: one that deleted a rule had the files it covered, ignored and
 * never in `tree`, removed for good. So the tree's .gitignore files are checked
 * out first and any the tree does not have are removed. One that ignores
 * itself stays, and so does what it covers; git ignores both, so neither can
 * reach a commit.
 *
 * Before that, files a worker staged that are not in `tree` are unstaged, so
 * the clean treats them as the untracked files they were. They used to be
 * deleted outright, which took an ignored file the worker had force-staged:
 * one that existed before the task, never in `tree`, gone for good. A staged
 * file standing where the tree has a directory does not block the checkout
 * below; `checkout-index -f` replaces it.
 *
 * Last, a path the restored index tracks but `tree` lacks was deleted at
 * capture, so it is removed from disk. The clean cannot do it when the path
 * also matches an ignore rule, and a worker that wrote it again left it there.
 * A directory there came from `tree` and stays, and nothing is removed through
 * a symlinked directory, which would reach outside the path it names.
 *
 * Then the real index is put back as it was. Without it, an edit a worker
 * staged to a tracked file stayed staged after a rollback that called itself
 * complete, since the fingerprint reads files through a temporary index and
 * never saw it. The index file is written back whole from the copy captured
 * with `staged`: rebuilding it from a tree drops per-path flags such as
 * skip-worktree and every `git add -N` entry, which a tree cannot hold. It is
 * only written when what is staged differs, read from the index alone so that
 * a work tree git cannot stage does not stop the rest of the rollback.
 */
export async function restoreTree(
	workspaceRel: string,
	tree: string,
	staged?: Pick<Fingerprint, 'index' | 'indexBlob'>
): Promise<void> {
	const t = shellQuote(tree);
	const putIndex = staged ? putIndexScript(staged) : '';
	const res = await getExecutor().exec(
		`gd=$(git rev-parse --git-dir) || exit 1
gone=$(mktemp) || exit 1
tmp=$(mktemp) || exit 1
gi=$(mktemp) || exit 1
trap 'rm -f "$tmp" "$gone" "$gi"' EXIT
rm -f "$tmp"
if [ -f "$gd/index" ]; then
	git diff-index --cached --name-only --diff-filter=A -z ${t} > "$gone" || exit 1
fi
if [ -s "$gone" ]; then
	xargs -0 git reset -q -- < "$gone" || exit 1
fi
GIT_INDEX_FILE="$tmp" git read-tree ${t} || exit 1
GIT_INDEX_FILE="$tmp" git ls-files -z -- ':(glob)**/.gitignore' | GIT_INDEX_FILE="$tmp" xargs -0 -r git checkout-index -f -- || exit 1
# Repeated: removing one rule can bring another, which it hid, into view.
i=0
while [ $i -lt 20 ]; do
	GIT_INDEX_FILE="$tmp" git ls-files -o -z --exclude-standard -- ':(glob)**/.gitignore' > "$gi" || exit 1
	[ -s "$gi" ] || break
	xargs -0 rm -f -- < "$gi" || exit 1
	i=$((i + 1))
done
${putIndex}
GIT_INDEX_FILE="$tmp" git clean -fdq || exit 1
GIT_INDEX_FILE="$tmp" git checkout-index -a -f || exit 1
git diff-index --cached --name-only --diff-filter=A -z ${t} | xargs -0 -r sh -c '
for p; do
	safe=1
	case $p in */*) d=\${p%/*} ;; *) d= ;; esac
	while [ -n "$d" ]; do
		if [ -L "$d" ]; then safe=0; break; fi
		case $d in */*) d=\${d%/*} ;; *) d= ;; esac
	done
	if [ $safe = 1 ] && { [ -L "$p" ] || [ ! -d "$p" ]; }; then rm -f -- "$p" || exit 1; fi
done' sh || exit 1
`,
		{ cwdRel: workspaceRel, timeoutMs: 60_000 }
	);
	if (res.code !== 0) {
		throw new Error(`Could not restore the work tree. Git said, as data:\n${fenced(scrubSecrets(res.stderr || res.stdout).trim())}`);
	}
}

/** Write the index back from `staged` if what is staged has changed since; nothing else. */
function putIndexScript(staged: Pick<Fingerprint, 'index' | 'indexBlob'>): string {
	return `${STAGED_DIGEST_FN}
if [ -f "$gd/index" ]; then cur=$(staged_digest) || exit 1; else cur=; fi
if [ "$cur" != ${shellQuote(staged.index)} ]; then
	${
		staged.indexBlob
			? // Through index.lock, made with noclobber: git's own protocol, so a
				// concurrent writer or a symlink planted at the lock path fails this
				// instead of being written through.
				// Taken before anything can fail, so every later failure owns the
				// lock it removes, and a stale one is never left to block git.
				`( set -C; : > "$gd/index.lock" ) || exit 1
	git cat-file blob ${shellQuote(staged.indexBlob)} > "$gd/index.lock" || { rm -f "$gd/index.lock"; exit 1; }
	mv -f "$gd/index.lock" "$gd/index" || { rm -f "$gd/index.lock"; exit 1; }`
			: `( set -C; : > "$gd/index.lock" ) || exit 1
	rm -f "$gd/index"; s=$?; rm -f "$gd/index.lock"; [ $s = 0 ] || exit 1`
	}
fi`;
}

/**
 * Put back only what is staged. For a change that touched nothing else: a full
 * restore checks out every file from a tree that cannot see local edits git
 * has been told to ignore (assume-unchanged), and would overwrite them.
 */
export async function restoreIndex(
	workspaceRel: string,
	staged: Pick<Fingerprint, 'index' | 'indexBlob'>
): Promise<void> {
	const res = await getExecutor().exec(`gd=$(git rev-parse --git-dir) || exit 1\n${putIndexScript(staged)}\n`, {
		cwdRel: workspaceRel,
		timeoutMs: 30_000
	});
	if (res.code !== 0) {
		throw new Error(`Could not restore the index. Git said, as data:\n${fenced(scrubSecrets(res.stderr || res.stdout).trim())}`);
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
		throw new Error(`Could not put HEAD back. Git said, as data:\n${fenced(scrubSecrets(res.stderr || res.stdout).trim())}`);
	}
}

export interface CheckResult {
	code: number;
	/** stdout and stderr, scrubbed, the last 1500 characters unless the caller asked for more. */
	output: string;
	timedOut: boolean;
	/** What the command changed in the work tree or in HEAD, already reverted; null when it changed nothing. */
	wrote: string | null;
}

/**
 * `outputChars` is wider for a probe than for a task check: a check's output is
 * evidence the overseer skims, and a probe's is the thing it ran the command to read.
 */
export async function runCheck(
	workspaceRel: string,
	command: string,
	opts: { timeoutMs?: number; outputChars?: number } = {}
): Promise<CheckResult> {
	const before = await treeFingerprint(workspaceRel);
	if (!before) throw new Error('The workspace is not a git work tree, so a check cannot be run safely.');

	const timeoutMs = opts.timeoutMs ?? taskCheckTimeoutMs();
	const outputChars = opts.outputChars ?? MAX_OUTPUT_CHARS;
	const started = Date.now();
	// `.git` is read-only to the command itself, on an executor that can enforce
	// it. Without that, a command could stage an edit the restore below leaves
	// in the index, or remove the metadata the restore depends on.
	const res = await getExecutor().exec(command, { cwdRel: workspaceRel, timeoutMs, readOnly: ['.git'] });
	// The docker executor reports 124; the local one reports whatever the
	// killed process left, which is 1, so the clock is the second witness.
	const timedOut = res.code === 124 || (res.code !== 0 && Date.now() - started >= timeoutMs - 250);

	let after = await treeFingerprint(workspaceRel);
	if (!after) {
		throw new Error(
			'The command removed the git metadata of the workspace, so what it changed cannot be undone. The workspace needs to be recreated.'
		);
	}
	let wrote: string | null = null;
	if (!sameFingerprint(before, after)) {
		const lines: string[] = [];
		if (before.head !== after.head || before.ref !== after.ref) {
			lines.push('HEAD moved: the command made a commit or switched branch.');
		}
		if (before.tree !== after.tree) lines.push(await changedPaths(workspaceRel, before.tree, after.tree));
		if (before.index !== after.index) lines.push('The command changed what is staged.');
		if (before.head !== after.head || before.ref !== after.ref) await restoreHead(workspaceRel, before);
		if (before.tree === after.tree) await restoreIndex(workspaceRel, before);
		else await restoreTree(workspaceRel, before.tree, before);
		// The fingerprint above was taken under the command's ignore rules. One
		// that added a rule and then wrote a file under it hid that file from the
		// first pass; with the original .gitignore back, the file shows, so the
		// tree is measured and cleaned again under the rules it started with.
		after = await treeFingerprint(workspaceRel);
		if (after && after.tree !== before.tree) {
			lines.push(await changedPaths(workspaceRel, before.tree, after.tree));
			await restoreTree(workspaceRel, before.tree, before);
		}
		// The clean leaves a nested repository alone, and widening it to -ff would
		// also take one that was there before the command ran. So the result is
		// measured rather than assumed, and a leftover is reported as one.
		after = await treeFingerprint(workspaceRel);
		if (!after || !sameFingerprint(before, after)) {
			const left = after ? await changedPaths(workspaceRel, before.tree, after.tree) : '';
			throw new Error(
				`The command changed the work tree and not all of it could be undone.${left ? ` What is still changed follows as data:\n${fenced(left)}` : ''}`
			);
		}
		wrote = lines.join('\n');
	}

	const combined = scrubSecrets([res.stdout, res.stderr].filter(Boolean).join('\n')).trim();
	return {
		code: res.code,
		output: combined.length > outputChars ? `…${combined.slice(-outputChars)}` : combined,
		timedOut,
		wrote
	};
}
