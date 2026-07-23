import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { LoopTool } from '../loop';
import { getExecutor } from './executor';
import { safeJoin, scrubSecrets, shellQuote, workspaceAbs } from './workspace';

const MAX_FILE_CHARS = 60_000;
const MAX_LIST_ENTRIES = 500;
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.svelte-kit', '__pycache__']);

export interface CodingToolContext {
	workspaceRel: string;
	mode: 'plan' | 'implement';
}

/**
 * The coding toolset. In plan mode only the read-only tools are offered, so
 * a planning session physically cannot modify anything.
 */
export function codingTools(ctx: CodingToolContext): LoopTool[] {
	const readOnly: LoopTool[] = [
		{
			def: {
				name: 'list_files',
				description: 'List files in the repository (recursive, common junk dirs skipped).',
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
			def: {
				name: 'read_file',
				description: 'Read a file from the repository.',
				parameters: {
					type: 'object',
					properties: { path: { type: 'string' } },
					required: ['path']
				}
			},
			describe: (a) => String(a.path ?? ''),
			execute: async (a) => {
				const content = readFileSync(safeJoin(ctx.workspaceRel, String(a.path)), 'utf8');
				return content.length > MAX_FILE_CHARS
					? content.slice(0, MAX_FILE_CHARS) + `\n…(truncated, ${content.length} chars total)`
					: content;
			}
		},
		{
			def: {
				name: 'grep_files',
				description: 'Search file contents with a regex (git grep).',
				parameters: {
					type: 'object',
					properties: { pattern: { type: 'string' } },
					required: ['pattern']
				}
			},
			describe: (a) => String(a.pattern ?? ''),
			execute: async (a) => {
				const res = await getExecutor().exec(
					`git grep -n -E ${shellQuote(String(a.pattern))} || true`,
					{ cwdRel: ctx.workspaceRel, timeoutMs: 30_000 }
				);
				return scrubSecrets(res.stdout).slice(0, MAX_FILE_CHARS) || '(no matches)';
			}
		},
		{
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
				return scrubSecrets(res.stdout + res.stderr).slice(0, MAX_FILE_CHARS) || '(clean)';
			}
		}
	];

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
					'Replace an exact string in a file. The old string must appear exactly once.',
				parameters: {
					type: 'object',
					properties: {
						path: { type: 'string' },
						old: { type: 'string' },
						new: { type: 'string' }
					},
					required: ['path', 'old', 'new']
				}
			},
			describe: (a) => String(a.path ?? ''),
			execute: async (a) => {
				const abs = safeJoin(ctx.workspaceRel, String(a.path));
				const content = readFileSync(abs, 'utf8');
				const oldStr = String(a.old);
				const first = content.indexOf(oldStr);
				if (first === -1) throw new Error('old string not found');
				if (content.indexOf(oldStr, first + 1) !== -1) {
					throw new Error('old string is not unique — add more context');
				}
				writeFileSync(abs, content.replace(oldStr, String(a.new)));
				return `Edited ${String(a.path)}`;
			}
		},
		{
			def: {
				name: 'bash',
				description:
					'Run a shell command in the repository root (tests, builds, scripts). 120s timeout.',
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
				return out.slice(0, MAX_FILE_CHARS);
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
		{
			def: {
				name: 'git_push',
				description: "Push the session's work branch to the remote.",
				parameters: { type: 'object', properties: {} }
			},
			execute: async () => {
				const res = await getExecutor().exec('git push -u origin HEAD', {
					cwdRel: ctx.workspaceRel,
					timeoutMs: 120_000
				});
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
