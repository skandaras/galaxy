import { beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from '$lib/server/db';
import { getExecutor } from './executor';
import { codingTools, readOnlyCodingTools, renderLines, type CodingToolContext } from './tools';

const WS = 'workspaces/tools-test';
const abs = (...parts: string[]) => join(dataDir, WS, ...parts);

const ctx: CodingToolContext = {
	workspaceRel: WS,
	mode: 'implement',
	repoUrl: 'https://example.invalid/x/y.git'
};

const tool = (name: string) => {
	const found = codingTools(ctx).find((t) => t.def.name === name);
	if (!found) throw new Error(`no such tool: ${name}`);
	return found;
};

beforeAll(async () => {
	rmSync(abs(), { recursive: true, force: true });
	mkdirSync(abs('src', 'deep'), { recursive: true });
	writeFileSync(abs('src', 'a.ts'), 'export const a = 1;\n');
	writeFileSync(abs('src', 'deep', 'b.ts'), 'export const b = 2;\n');
	writeFileSync(abs('notes.md'), '# notes\n');
	writeFileSync(abs('.gitignore'), 'ignored.ts\n');
	writeFileSync(abs('ignored.ts'), 'export const nope = 0;\n');
	// A real repo: glob and grep_files are git commands, not filesystem walks.
	await getExecutor().exec(
		'git init -q && git config user.email t@t && git config user.name t && git add -A && git commit -qm init',
		{ cwdRel: WS, timeoutMs: 60_000 }
	);
});

describe('renderLines', () => {
	const file = ['one', 'two', 'three', 'four', 'five'].join('\n');

	it('numbers the lines it returns', () => {
		expect(renderLines(file, 1, 2, 10_000)).toBe('1→one\n2→two\n…(3 more lines — call again with start_line=3)');
	});

	it('starts where it is asked to, so a grep hit can be read directly', () => {
		// The composition this exists for: grep says path:3:, read starts at 3.
		expect(renderLines(file, 3, 1, 10_000)).toContain('3→three');
	});

	it('says nothing remains when it reached the end', () => {
		expect(renderLines(file, 4, 99, 10_000)).toBe('4→four\n5→five');
	});

	it('pads the gutter to the widest number shown', () => {
		const long = Array.from({ length: 12 }, (_, i) => `line${i + 1}`).join('\n');
		const out = renderLines(long, 1, 12, 10_000);
		expect(out).toContain(' 1→line1');
		expect(out).toContain('12→line12');
	});

	it('stops at the character budget and says how to continue', () => {
		const out = renderLines(file, 1, 5, 12);
		expect(out).toContain('1→one');
		expect(out).toContain('call again with start_line=');
		expect(out).not.toContain('5→five');
	});

	it('still returns one line when that line alone busts the budget', () => {
		// Truncating to nothing would leave the model with a result it cannot act
		// on and no way to make progress.
		expect(renderLines('a'.repeat(500), 1, 5, 10)).toContain('1→aaa');
	});

	it('says so rather than returning nothing past the end of the file', () => {
		expect(renderLines(file, 99, 5, 10_000)).toBe('(file has 5 lines; nothing at line 99)');
	});
});

describe('glob', () => {
	const run = (args: Record<string, unknown>) => readOnlyCodingTools(ctx)
		.find((t) => t.def.name === 'glob')!
		.execute(args);

	it('matches a pattern across directories', async () => {
		const out = await run({ pattern: 'src/**/*.ts' });
		expect(out.split('\n').sort()).toEqual(['src/a.ts', 'src/deep/b.ts']);
	});

	it('honours .gitignore, which is why it replaces a hardcoded skip list', async () => {
		const out = await run({ pattern: '**/*.ts' });
		expect(out).toContain('src/a.ts');
		expect(out).not.toContain('ignored.ts');
	});

	it('gives * and ** the meanings the model expects, not git pathspec defaults', async () => {
		// Bare pathspecs use fnmatch without FNM_PATHNAME, so `src/*.ts` used to
		// match every depth and `src/**/*.ts` skipped the top level. Both are the
		// wrong way round from every other glob the model has ever seen.
		expect((await run({ pattern: 'src/*.ts' })).split('\n')).toEqual(['src/a.ts']);
		expect((await run({ pattern: 'src/**/*.ts' })).split('\n').sort()).toEqual([
			'src/a.ts',
			'src/deep/b.ts'
		]);
	});

	it('says so plainly when nothing matches', async () => {
		expect(await run({ pattern: '*.rs' })).toBe('(no matches)');
	});

	it('refuses an empty pattern rather than listing the repo', async () => {
		await expect(run({ pattern: '  ' })).rejects.toThrow(/pattern is required/);
	});
});

describe('grep_files', () => {
	const run = (args: Record<string, unknown>) => readOnlyCodingTools(ctx)
		.find((t) => t.def.name === 'grep_files')!
		.execute(args);

	it('reports path:line:text, which read_file can act on', async () => {
		expect(await run({ pattern: 'const a' })).toContain('src/a.ts:1:');
	});

	it('can be scoped to a path', async () => {
		const out = await run({ pattern: 'export', path: 'src/deep' });
		expect(out).toContain('src/deep/b.ts');
		expect(out).not.toContain('src/a.ts');
	});
});

describe('edit_file', () => {
	const edit = (args: Record<string, unknown>) => tool('edit_file').execute(args);

	beforeAll(() => {
		writeFileSync(abs('edit.ts'), 'const x = 1;\nconst y = 1;\nconst z = 1;\n');
	});

	it('still takes a single old/new pair', async () => {
		writeFileSync(abs('single.ts'), 'hello world\n');
		await edit({ path: 'single.ts', old: 'world', new: 'there' });
		expect(readFileSync(abs('single.ts'), 'utf8')).toBe('hello there\n');
	});

	it('applies a batch of edits in one call', async () => {
		writeFileSync(abs('batch.ts'), 'a\nb\nc\n');
		const out = await edit({
			path: 'batch.ts',
			edits: [
				{ old: 'a', new: 'one' },
				{ old: 'b', new: 'two' }
			]
		});
		expect(readFileSync(abs('batch.ts'), 'utf8')).toBe('one\ntwo\nc\n');
		expect(out).toContain('2 changes');
	});

	it('writes nothing at all when one edit in a batch fails', async () => {
		// The reason edits are applied to a string and written once: a half-applied
		// rename is worse than a rejected one.
		writeFileSync(abs('atomic.ts'), 'keep me\n');
		await expect(
			edit({
				path: 'atomic.ts',
				edits: [
					{ old: 'keep', new: 'kept' },
					{ old: 'absent', new: 'x' }
				]
			})
		).rejects.toThrow(/edit 2 of 2 failed, nothing written/);
		expect(readFileSync(abs('atomic.ts'), 'utf8')).toBe('keep me\n');
	});

	it('replaces every occurrence when asked', async () => {
		writeFileSync(abs('all.ts'), 'x\nx\nx\n');
		await edit({ path: 'all.ts', old: 'x', new: 'y', replace_all: true });
		expect(readFileSync(abs('all.ts'), 'utf8')).toBe('y\ny\ny\n');
	});

	it('still refuses an ambiguous match without replace_all', async () => {
		await expect(edit({ path: 'edit.ts', old: '= 1;', new: '= 2;' })).rejects.toThrow(/not unique/);
	});

	it('names what it could not find', async () => {
		await expect(edit({ path: 'edit.ts', old: 'nowhere', new: 'x' })).rejects.toThrow(/not found/);
	});
});

describe('the toolset offered', () => {
	it('withholds every write tool in plan mode', () => {
		const names = codingTools({ ...ctx, mode: 'plan' }).map((t) => t.def.name);
		expect(names).not.toContain('write_file');
		expect(names).not.toContain('edit_file');
		expect(names).not.toContain('bash');
		expect(names).not.toContain('git_push');
	});

	it('offers exactly the read-only set in plan mode', () => {
		expect(codingTools({ ...ctx, mode: 'plan' }).map((t) => t.def.name)).toEqual(
			readOnlyCodingTools(ctx).map((t) => t.def.name)
		);
	});

	it('marks the read-only tools parallel-safe and the rest not', () => {
		const byName = new Map(codingTools(ctx).map((t) => [t.def.name, t.parallelSafe === true]));
		expect(byName.get('read_file')).toBe(true);
		expect(byName.get('glob')).toBe(true);
		expect(byName.get('write_file')).toBe(false);
		expect(byName.get('bash')).toBe(false);
	});

	it('tells the model that bash gets a fresh shell each time', () => {
		// Learned by failing before this: cd and exports vanished with the
		// container, and nothing said so.
		expect(tool('bash').def.description).toMatch(/fresh shell/);
	});
});
