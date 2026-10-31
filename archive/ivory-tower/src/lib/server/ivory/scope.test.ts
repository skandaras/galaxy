import { describe, expect, it } from 'vitest';
import { resolveShelfPath, ShelfScopeError } from './scope';

const reader = { slug: 'bees', writable: ['notes/'] };

describe('resolveShelfPath', () => {
	it('places a relative path in the project folder, and accepts the full path back', () => {
		expect(resolveShelfPath(reader, 'notes/N-001-a.md', 'write')).toBe('projects/bees/notes/N-001-a.md');
		expect(resolveShelfPath(reader, 'projects/bees/notes/N-001-a.md', 'write')).toBe(
			'projects/bees/notes/N-001-a.md'
		);
		expect(resolveShelfPath(reader, 'brief.md', 'read')).toBe('projects/bees/brief.md');
		expect(resolveShelfPath(reader, '', 'read')).toBe('projects/bees/');
	});

	it.each([
		['another project', 'projects/wasps/notes/N-001.md', /another project's folder/],
		['a slug that only starts the same', 'projects/beesx/notes/N-001.md', /another project's folder/],
		['climbing out', 'notes/../../wasps/brief.md', /"\." and "\.\."/],
		['climbing out from the top', '../wasps/notes/x.md', /"\." and "\.\."/],
		['an absolute path', '/etc/passwd', /absolute/],
		['percent-encoding', 'notes/%2e%2e/x.md', /percent-encoding/],
		['a backslash', 'notes\\..\\x.md', /backslashes/]
	])('refuses %s', (_label, path, message) => {
		expect(() => resolveShelfPath(reader, path, 'read')).toThrow(ShelfScopeError);
		expect(() => resolveShelfPath(reader, path, 'read')).toThrow(message);
	});

	it('lets the reader write notes and nothing else', () => {
		expect(() => resolveShelfPath(reader, 'brief.md', 'write')).toThrow(/may write only in projects\/bees\/notes\//);
		expect(() => resolveShelfPath(reader, 'claims/C-001.md', 'write')).toThrow(/may write only/);
		expect(() => resolveShelfPath(reader, 'notes/sub/N-001.md', 'write')).toThrow(/may write only/);
		expect(() => resolveShelfPath(reader, 'notes/N-001.txt', 'write')).toThrow(/ending in \.md/);
	});

	it('lets a read-only scope write nowhere', () => {
		expect(() => resolveShelfPath({ slug: 'bees', writable: [] }, 'notes/x.md', 'write')).toThrow(/nowhere/);
	});
});
