import { toolResultMaxChars } from '../limits';
import { getExecutor } from './executor';
import { scrubSecrets, shellQuote } from './workspace';

/**
 * Checks a repository runs before the agent may commit or push.
 *
 * The coding prompt used to ask for this ("run relevant checks with bash when
 * available") and AGENTS.md says lint, check and test run before every commit.
 * Nothing enforced either: `git_commit` and `git_push` ran whatever they were
 * handed, so the repo's most important rule held exactly as often as a model
 * remembered it. A check that is code does not depend on that.
 *
 * Declared by the repository, in `.galaxy/hooks.json`, so the checks live
 * beside the code they check. Read from the **base branch**, never the work
 * tree: a session that could edit its own gate could pass it by deleting it,
 * and a change to the hooks then has to be merged by a person first.
 */

export const HOOKS_FILE = '.galaxy/hooks.json';

export type HookStage = 'pre_commit' | 'pre_push';

export interface RepoHook {
	run: string;
	timeoutSeconds: number;
}

export type RepoHooks = Record<HookStage, RepoHook[]>;

export interface HookRun {
	stage: HookStage;
	command: string;
	code: number;
	durationMs: number;
}

const DEFAULT_TIMEOUT_SECONDS = 600;
const MAX_TIMEOUT_SECONDS = 1_800;

export const NO_HOOKS: RepoHooks = { pre_commit: [], pre_push: [] };

/**
 * Parse the hooks file. An entry is a command string or `{ run, timeoutSeconds }`.
 *
 * Throws on malformed JSON rather than reading it as "no hooks": a gate that
 * opens because someone broke its config is not a gate.
 *
 * Exported for tests.
 */
export function parseHooks(raw: string): RepoHooks {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new Error(`${HOOKS_FILE} on the base branch is not valid JSON: ${String(err)}`);
	}
	const obj = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
	const stage = (name: HookStage): RepoHook[] => {
		const list = Array.isArray(obj[name]) ? (obj[name] as unknown[]) : [];
		return list
			.map((entry) => {
				const e = (typeof entry === 'string' ? { run: entry } : entry) as Record<string, unknown>;
				const run = typeof e?.run === 'string' ? e.run.trim() : '';
				const t = Number(e?.timeoutSeconds);
				return {
					run,
					timeoutSeconds:
						Number.isFinite(t) && t > 0
							? Math.min(MAX_TIMEOUT_SECONDS, Math.floor(t))
							: DEFAULT_TIMEOUT_SECONDS
				};
			})
			.filter((h) => h.run);
	};
	return { pre_commit: stage('pre_commit'), pre_push: stage('pre_push') };
}

/** The hooks as the base branch declares them. No file means no hooks. */
export async function readRepoHooks(target: {
	workspaceRel: string;
	baseBranch: string;
}): Promise<RepoHooks> {
	const res = await getExecutor().exec(
		`git show ${shellQuote(`origin/${target.baseBranch}:${HOOKS_FILE}`)}`,
		{ cwdRel: target.workspaceRel, timeoutMs: 30_000 }
	);
	if (res.code !== 0) return NO_HOOKS;
	return parseHooks(res.stdout);
}

/**
 * The commit a pre_push run last passed on, per workspace.
 *
 * `open_pull_request` pushes too, and the usual sequence is git_push followed
 * by it. Running the whole test suite twice for one commit buys nothing, so a
 * clean tree at the same HEAD that already passed is not re-checked.
 */
const passedPush = new Map<string, string>();

async function cleanHead(workspaceRel: string): Promise<string | null> {
	const res = await getExecutor().exec('git status --porcelain && git rev-parse HEAD', {
		cwdRel: workspaceRel,
		timeoutMs: 30_000
	});
	if (res.code !== 0) return null;
	const lines = res.stdout.trim().split('\n');
	return lines.length === 1 ? lines[0] : null;
}

/**
 * Run a stage's hooks in order, stopping at the first failure.
 *
 * Throws with the failing command's output, which is how a refusal reaches the
 * model: as the tool's error, so it can fix what broke and call again. The
 * tail of the output is kept rather than the head, because test runners and
 * linters print their verdict last.
 */
export async function runRepoHooks(
	stage: HookStage,
	target: { workspaceRel: string; baseBranch: string }
): Promise<HookRun[]> {
	const hooks = (await readRepoHooks(target))[stage];
	if (!hooks.length) return [];

	const head = stage === 'pre_push' ? await cleanHead(target.workspaceRel) : null;
	if (head && passedPush.get(target.workspaceRel) === head) return [];

	const runs: HookRun[] = [];
	for (const hook of hooks) {
		const started = Date.now();
		const res = await getExecutor().exec(hook.run, {
			cwdRel: target.workspaceRel,
			timeoutMs: hook.timeoutSeconds * 1000
		});
		runs.push({
			stage,
			command: hook.run,
			code: res.code,
			durationMs: Date.now() - started
		});
		if (res.code !== 0) {
			const output = scrubSecrets(`${res.stdout}\n${res.stderr}`).trim();
			const cap = Math.max(1_000, toolResultMaxChars() - 500);
			const tail = output.length > cap ? `…${output.slice(-cap)}` : output;
			throw new HookFailure(
				`Refused: the repository's ${stage} check \`${hook.run}\` failed (exit ${res.code}). ` +
					`Fix what it reports, then try again.\n\n${tail}`,
				runs
			);
		}
	}
	if (head) passedPush.set(target.workspaceRel, head);
	return runs;
}

/** A refusal, carrying the runs so far for the Observatory. */
export class HookFailure extends Error {
	constructor(
		message: string,
		readonly runs: HookRun[]
	) {
		super(message);
		this.name = 'HookFailure';
	}
}
