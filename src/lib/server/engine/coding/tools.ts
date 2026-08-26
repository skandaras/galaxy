import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { LoopTool } from '../loop';
import { toolResultMaxChars } from '../limits';
import { getExecutor } from './executor';
import { openPullRequest } from './pull-request';
import { setPlan, type PlanItem } from './state';
import { gitAuthArgs, safeJoin, scrubSecrets, shellQuote, workspaceAbs } from './workspace';

/** Hard ceiling on one tool result; `maxFileChars()` is the softer default. */
const MAX_FILE_CHARS = 60_000;
/** Default slice size, kept below the hard cap so paging is the normal path. */
const maxFileChars = () => Math.min(MAX_FILE_CHARS, toolResultMaxChars());
const MAX_LIST_ENTRIES = 500;
/** Lines returned when the model doesn't say — enough for most whole files. */
const DEFAULT_READ_LINES = 800;
const MAX_READ_LINES = 3_000;
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.svelte-kit', '__pycache__']);

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
	const n = typeof raw === 'number' ? raw : Number(raw);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, Math.floor(n)));
}

export interface CodingToolContext {
	/**
	 * The session's chat, for the tools that write to session state rather than
	 * to the workspace. Optional so the tool catalogue can construct a context
	 * without one; update_plan is simply not offered when it is absent.
	 */
	chatId?: string;
	workspaceRel: string;
	mode: 'plan' | 'implement';
	repoUrl: string;
	/** Branch the session was cut from — the base a pull request targets. */
	baseBranch: string;
	/** Branch this session works on, and the head of any pull request. */
	workBranch: string;
}

/**
 * Render a slice of a file with a line-number gutter, stopping at the character
 * budget however many lines were asked for.
 *
 * The gutter is what makes `grep_files` and `read_file` compose: grep reports
 * `path:412:`, and before this there was no way to ask for line 412 — reads
 * were addressed by character offset, so the model either guessed or pulled the
 * whole file in to count.
 *
 * Exported for tests.
 */
export function renderLines(
	content: string,
	startLine: number,
	lineCount: number,
	charBudget: number
): string {
	const lines = content.split('\n');
	if (startLine > lines.length) {
		return `(file has ${lines.length} line${lines.length === 1 ? '' : 's'}; nothing at line ${startLine})`;
	}
	const from = startLine - 1;
	const wanted = lines.slice(from, from + lineCount);
	const width = String(from + wanted.length).length;
	const out: string[] = [];
	let used = 0;
	let shown = 0;
	for (const [i, line] of wanted.entries()) {
		const rendered = `${String(from + i + 1).padStart(width)}→${line}`;
		// Always render at least one line: a single enormous line must produce
		// something rather than an empty result the model cannot act on.
		if (used + rendered.length > charBudget && shown > 0) break;
		out.push(rendered);
		used += rendered.length + 1;
		shown++;
	}
	const nextLine = from + shown + 1;
	const remaining = lines.length - (from + shown);
	// Say how to get the rest rather than just truncating: without the hint the
	// model re-reads from the top and pays for the same content twice.
	if (remaining > 0) {
		out.push(`…(${remaining} more line${remaining === 1 ? '' : 's'} — call again with start_line=${nextLine})`);
	}
	return out.join('\n');
}

/**
 * Turn a glob into a git pathspec that means what the model thinks it means.
 *
 * A bare pathspec is matched with fnmatch and no FNM_PATHNAME, so `*` crosses
 * directory separators and `**` carries no special meaning. A recursive
 * pattern under a directory therefore missed the files sitting directly in it,
 * because it required at least one directory in between, while a shallow
 * pattern quietly matched every depth. Both are the wrong way round from every
 * other glob the model has ever been given.
 *
 * `:(glob)` magic gives the standard semantics instead: `*` stops at a
 * separator, and a `**` component matches zero or more directories.
 *
 * Exported for tests.
 */
export function globPathspec(pattern: string): string {
	// Leave a pathspec the caller has already made magic alone.
	return pattern.startsWith(':') ? pattern : `:(glob)${pattern}`;
}

/** Read the plan out of tool arguments, dropping anything malformed. */
function readPlan(args: Record<string, unknown>): PlanItem[] {
	const raw = Array.isArray(args.items) ? (args.items as Record<string, unknown>[]) : [];
	return raw
		.map((i) => ({
			text: String(i?.text ?? '').trim(),
			// Anything unrecognised is work still to do, which is the reading that
			// cannot quietly lose a step.
			status: (['todo', 'doing', 'done'].includes(String(i?.status)) ? i.status : 'todo') as
				PlanItem['status']
		}))
		.filter((i) => i.text);
}

/** "2 done, 1 doing, 3 to do" — the line the run timeline shows. */
function summarisePlan(items: PlanItem[]): string {
	const count = (s: PlanItem['status']) => items.filter((i) => i.status === s).length;
	return [
		count('done') ? `${count('done')} done` : '',
		count('doing') ? `${count('doing')} doing` : '',
		count('todo') ? `${count('todo')} to do` : ''
	]
		.filter(Boolean)
		.join(', ') || 'empty';
}

/** One replacement against an in-memory string, so a failure writes nothing. */
function applyEdit(content: string, old: string, replacement: string, replaceAll: boolean): string {
	if (!old) throw new Error('old string is required');
	const first = content.indexOf(old);
	if (first === -1) throw new Error(`old string not found: ${JSON.stringify(old.slice(0, 80))}`);
	if (replaceAll) return content.split(old).join(replacement);
	if (content.indexOf(old, first + 1) !== -1) {
		throw new Error(
			`old string is not unique: ${JSON.stringify(old.slice(0, 80))} — add more context, or set replace_all`
		);
	}
	return content.replace(old, replacement);
}

/**
 * The tools that only look. Offered on their own in plan mode, so a planning
 * session physically cannot modify anything — and shared with the explore
 * sub-agent, which must be read-only for the same reason.
 */
export function readOnlyCodingTools(ctx: CodingToolContext): LoopTool[] {
	return [
		{
			parallelSafe: true,
			def: {
				name: 'glob',
				description:
					'Find files by path pattern, e.g. "src/**/*.ts" or "*.json". Respects .gitignore. ' +
					'Prefer this over list_files when you know roughly what you are looking for.',
				parameters: {
					type: 'object',
					properties: {
						pattern: { type: 'string', description: 'A glob, matched against repo-relative paths' }
					},
					required: ['pattern']
				}
			},
			describe: (a) => String(a.pattern ?? ''),
			execute: async (a) => {
				const pattern = String(a.pattern ?? '').trim();
				if (!pattern) throw new Error('pattern is required');
				// --others --exclude-standard picks up new files the agent has just
				// written without dragging in node_modules: .gitignore does the
				// filtering that the hardcoded skip list does for list_files.
				const res = await getExecutor().exec(
					`git ls-files --cached --others --exclude-standard -- ${shellQuote(globPathspec(pattern))}`,
					{ cwdRel: ctx.workspaceRel, timeoutMs: 30_000 }
				);
				const rows = res.stdout.split('\n').filter(Boolean);
				if (!rows.length) return '(no matches)';
				const shown = rows.slice(0, MAX_LIST_ENTRIES);
				const extra = rows.length - shown.length;
				return shown.join('\n') + (extra > 0 ? `\n…(${extra} more — narrow the pattern)` : '');
			}
		},
		{
			parallelSafe: true,
			def: {
				name: 'list_files',
				description:
					'List files in the repository (recursive, common junk dirs skipped). Use glob instead ' +
					'when you know the shape of what you want.',
				parameters: {
					type: 'object',
					properties: { dir: { type: 'string', description: 'Subdirectory, default repo root' } }
				}
			},
			describe: (a) => String(a.dir ?? '.'),
			execute: async (a) => {
				const base = safeJoin(ctx.workspaceRel, String(a.dir ?? '.'));
				const rows: string[] = [];
				walk(base, workspaceAbs(ctx.workspaceRel), rows);
				return rows.slice(0, MAX_LIST_ENTRIES).join('\n') || '(empty)';
			}
		},
		{
			parallelSafe: true,
			def: {
				name: 'read_file',
				description:
					'Read a file from the repository. Returns lines with a "12→" line-number gutter, so a ' +
					'hit from grep_files can be read directly with start_line. Page through a long file ' +
					'with start_line rather than pulling all of it into context. The gutter is display ' +
					'only — never include line numbers in an edit_file "old" string.',
				parameters: {
					type: 'object',
					properties: {
						path: { type: 'string' },
						start_line: { type: 'number', description: 'First line to return, 1-based (default 1)' },
						line_count: {
							type: 'number',
							description: `How many lines to return (default ${DEFAULT_READ_LINES})`
						}
					},
					required: ['path']
				}
			},
			describe: (a) => String(a.path ?? ''),
			execute: async (a) => {
				const content = readFileSync(safeJoin(ctx.workspaceRel, String(a.path)), 'utf8');
				const startLine = clampInt(a.start_line, 1, 1, Number.MAX_SAFE_INTEGER);
				const lineCount = clampInt(a.line_count, DEFAULT_READ_LINES, 1, MAX_READ_LINES);
				return renderLines(content, startLine, lineCount, maxFileChars());
			}
		},
		{
			parallelSafe: true,
			def: {
				name: 'grep_files',
				description:
					'Search file contents with a regex (git grep). Results are "path:line:text" — read a ' +
					'hit with read_file and start_line rather than opening the whole file.',
				parameters: {
					type: 'object',
					properties: {
						pattern: { type: 'string' },
						path: {
							type: 'string',
							description: 'Optional path or glob to search within, e.g. "src/**/*.ts"'
						}
					},
					required: ['pattern']
				}
			},
			describe: (a) => String(a.pattern ?? ''),
			execute: async (a) => {
				const scope = String(a.path ?? '').trim();
				const res = await getExecutor().exec(
					`git grep -n -E ${shellQuote(String(a.pattern))}${scope ? ` -- ${shellQuote(scope)}` : ''} || true`,
					{ cwdRel: ctx.workspaceRel, timeoutMs: 30_000 }
				);
				return scrubSecrets(res.stdout).slice(0, maxFileChars()) || '(no matches)';
			}
		},
		{
			parallelSafe: true,
			def: {
				name: 'git_status',
				description: 'Show git status and the diff of uncommitted changes.',
				parameters: { type: 'object', properties: {} }
			},
			execute: async () => {
				const res = await getExecutor().exec('git status --short && git diff', {
					cwdRel: ctx.workspaceRel,
					timeoutMs: 30_000
				});
				return scrubSecrets(res.stdout + res.stderr).slice(0, maxFileChars()) || '(clean)';
			}
		}
	];
}

/**
 * The coding toolset. In plan mode only the read-only tools are offered, so
 * a planning session physically cannot modify anything.
 */
export function codingTools(ctx: CodingToolContext): LoopTool[] {
	const readOnly = readOnlyCodingTools(ctx);
	if (ctx.mode === 'plan') return readOnly;

	const writeTools: LoopTool[] = [
		{
			def: {
				name: 'write_file',
				description: 'Create or overwrite a file with the given content.',
				parameters: {
					type: 'object',
					properties: { path: { type: 'string' }, content: { type: 'string' } },
					required: ['path', 'content']
				}
			},
			describe: (a) => String(a.path ?? ''),
			execute: async (a) => {
				const abs = safeJoin(ctx.workspaceRel, String(a.path));
				mkdirSync(dirname(abs), { recursive: true });
				writeFileSync(abs, String(a.content ?? ''));
				return `Wrote ${String(a.path)}`;
			}
		},
		{
			def: {
				name: 'edit_file',
				description:
					'Replace exact strings in a file. Pass old/new for one change, or edits: [{old, new}] ' +
					'to make several in one call — they are applied in order and all or nothing, so a ' +
					'rename across a file costs one call rather than one per site. Each old string must ' +
					'appear exactly once unless replace_all is set. Never include read_file line numbers.',
				parameters: {
					type: 'object',
					properties: {
						path: { type: 'string' },
						old: { type: 'string', description: 'The exact text to replace' },
						new: { type: 'string', description: 'What to put in its place' },
						edits: {
							type: 'array',
							description: 'Several replacements, applied in order. Use instead of old/new.',
							items: {
								type: 'object',
								properties: { old: { type: 'string' }, new: { type: 'string' } },
								required: ['old', 'new']
							}
						},
						replace_all: {
							type: 'boolean',
							description: 'Replace every occurrence rather than requiring a unique match'
						}
					},
					required: ['path']
				}
			},
			describe: (a) => String(a.path ?? ''),
			execute: async (a) => {
				const abs = safeJoin(ctx.workspaceRel, String(a.path));
				const replaceAll = a.replace_all === true;
				const batch = Array.isArray(a.edits) ? (a.edits as Record<string, unknown>[]) : [];
				const edits = batch.length
					? batch.map((e) => ({ old: String(e.old ?? ''), new: String(e.new ?? '') }))
					: [{ old: String(a.old ?? ''), new: String(a.new ?? '') }];

				// Applied to a string and written once: a batch that fails halfway
				// must leave the file exactly as it was, not half-edited.
				let content = readFileSync(abs, 'utf8');
				for (const [i, edit] of edits.entries()) {
					try {
						content = applyEdit(content, edit.old, edit.new, replaceAll);
					} catch (err) {
						throw new Error(
							edits.length > 1
								? `edit ${i + 1} of ${edits.length} failed, nothing written: ${String(err instanceof Error ? err.message : err)}`
								: String(err instanceof Error ? err.message : err)
						);
					}
				}
				writeFileSync(abs, content);
				return edits.length > 1
					? `Edited ${String(a.path)} (${edits.length} changes)`
					: `Edited ${String(a.path)}`;
			}
		},
		{
			def: {
				name: 'bash',
				description:
					'Run a shell command in the repository root (tests, builds, scripts). 120s timeout. ' +
					'Each call runs in a fresh shell, so cd, exported variables and background processes ' +
					'do not carry over — chain steps with && in one command. The workspace itself does ' +
					'persist, so installed dependencies and build output survive between calls.',
				parameters: {
					type: 'object',
					properties: { command: { type: 'string' } },
					required: ['command']
				}
			},
			describe: (a) => String(a.command ?? '').slice(0, 120),
			execute: async (a) => {
				const res = await getExecutor().exec(String(a.command), {
					cwdRel: ctx.workspaceRel,
					timeoutMs: 120_000
				});
				const out = scrubSecrets(
					`exit ${res.code}\n${res.stdout}${res.stderr ? `\n--- stderr ---\n${res.stderr}` : ''}`
				);
				return out.slice(0, maxFileChars());
			}
		},
		{
			def: {
				name: 'git_commit',
				description: 'Stage all changes and commit with the given message.',
				parameters: {
					type: 'object',
					properties: { message: { type: 'string' } },
					required: ['message']
				}
			},
			describe: (a) => String(a.message ?? '').slice(0, 80),
			execute: async (a) => {
				const res = await getExecutor().exec(
					`git add -A && git commit -m ${shellQuote(String(a.message))}`,
					{ cwdRel: ctx.workspaceRel, timeoutMs: 30_000 }
				);
				if (res.code !== 0) throw new Error(scrubSecrets(res.stderr || res.stdout));
				return scrubSecrets(res.stdout);
			}
		},
		...(ctx.chatId
			? [
					{
						def: {
							name: 'update_plan',
							description:
								'Keep a short checklist of the work in front of you, carried across turns and ' +
								'shown back to you in the session state. Write it out when you start a task of ' +
								'more than a couple of steps, and call this again as you finish each item or ' +
								'find work you had not accounted for. Send the whole list each time — it ' +
								'replaces the previous one. Exactly one item should be "doing".',
							parameters: {
								type: 'object',
								properties: {
									items: {
										type: 'array',
										items: {
											type: 'object',
											properties: {
												text: { type: 'string', description: 'One step, in a few words' },
												status: { type: 'string', enum: ['todo', 'doing', 'done'] }
											},
											required: ['text', 'status']
										}
									}
								},
								required: ['items']
							}
						},
						describe: (a: Record<string, unknown>) => summarisePlan(readPlan(a)),
						execute: async (a: Record<string, unknown>) => {
							const items = readPlan(a);
							if (!items.length) throw new Error('items is required');
							setPlan(ctx.chatId as string, items);
							return `Plan updated — ${summarisePlan(items)}.`;
						}
					} satisfies LoopTool
				]
			: []),
		{
			def: {
				name: 'open_pull_request',
				description:
					'Push the work branch and open a pull request against the base branch. Use this once ' +
					'the work is committed and you are ready for it to be reviewed. Calling it again on a ' +
					'session that already has one returns the existing pull request rather than failing.',
				parameters: {
					type: 'object',
					properties: {
						title: { type: 'string', description: 'One line saying what the change does' },
						body: {
							type: 'string',
							description: 'What changed and why, as the reviewer would want it'
						}
					},
					required: ['title']
				}
			},
			describe: (a) => String(a.title ?? '').slice(0, 80),
			execute: async (a) => {
				const pr = await openPullRequest(ctx, {
					title: String(a.title ?? ''),
					body: a.body === undefined ? undefined : String(a.body)
				});
				return pr.existing
					? `This branch already had an open pull request: ${pr.url}`
					: `Opened pull request #${pr.number}: ${pr.url}`;
			}
		},
		{
			def: {
				name: 'git_push',
				description: "Push the session's work branch to the remote.",
				parameters: { type: 'object', properties: {} }
			},
			execute: async () => {
				const res = await getExecutor().exec(
					`git ${gitAuthArgs(ctx.repoUrl)} push -u origin HEAD`,
					{
						cwdRel: ctx.workspaceRel,
						timeoutMs: 120_000
					}
				);
				if (res.code !== 0) throw new Error(scrubSecrets(res.stderr || res.stdout));
				return scrubSecrets(res.stdout + res.stderr) || 'Pushed';
			}
		}
	];
	return [...readOnly, ...writeTools];
}

function walk(dir: string, root: string, out: string[]): void {
	if (out.length >= MAX_LIST_ENTRIES) return;
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (out.length >= MAX_LIST_ENTRIES) return;
		if (SKIP_DIRS.has(entry.name)) continue;
		const abs = join(dir, entry.name);
		if (entry.isDirectory()) {
			walk(abs, root, out);
		} else {
			try {
				out.push(`${relative(root, abs)} (${statSync(abs).size}b)`);
			} catch {
				/* raced */
			}
		}
	}
}
