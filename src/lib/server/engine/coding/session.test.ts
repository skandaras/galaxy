import { describe, expect, it } from 'vitest';
import { splitPatch } from './session';

const PATCH = [
	'diff --git a/src/a.ts b/src/a.ts',
	'index 111..222 100644',
	'--- a/src/a.ts',
	'+++ b/src/a.ts',
	'@@ -1 +1 @@',
	'-const a = 1;',
	'+const a = 2;',
	'diff --git a/notes.md b/notes.md',
	'new file mode 100644',
	'--- /dev/null',
	'+++ b/notes.md',
	'@@ -0,0 +1 @@',
	'+# notes'
].join('\n');

describe('splitPatch', () => {
	it('cuts a unified diff into one entry per file', () => {
		const files = splitPatch(PATCH);
		expect(files.map((f) => f.path)).toEqual(['src/a.ts', 'notes.md']);
	});

	it('keeps each file header with its own hunks', () => {
		const [first, second] = splitPatch(PATCH);
		expect(first.patch).toContain('diff --git a/src/a.ts');
		expect(first.patch).toContain('+const a = 2;');
		// And nothing leaks across the boundary.
		expect(first.patch).not.toContain('notes.md');
		expect(second.patch).not.toContain('const a');
	});

	it('names the file by its new path, so a rename reads as its result', () => {
		expect(splitPatch('diff --git a/old.ts b/new.ts\n+++ b/new.ts')[0].path).toBe('new.ts');
	});

	it('has nothing to show for an empty diff', () => {
		expect(splitPatch('')).toEqual([]);
		expect(splitPatch('\n\n')).toEqual([]);
	});

	it('ignores anything before the first file header', () => {
		// A truncated patch can start mid-file; a fragment with no header is not
		// attributable to any path and must not become one.
		expect(splitPatch('@@ -1 +1 @@\n-orphan line')).toEqual([]);
	});
});
