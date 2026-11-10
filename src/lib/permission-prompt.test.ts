import { describe, expect, it } from 'vitest';
import { applyPermissionChunk, permissionTitle, type OpenPermission } from './permission-prompt';

const open = (id: string): OpenPermission => ({ id, tool: 'write_file', summary: 'a.ts' });
const request = (id: string) => ({ type: 'permission', id, tool: 'write_file', summary: 'a.ts' });

describe('applyPermissionChunk', () => {
	it('opens on a request and closes on the matching decision', () => {
		const opened = applyPermissionChunk(null, request('p1'));
		expect(opened).toEqual({ id: 'p1', tool: 'write_file', server: undefined, summary: 'a.ts' });
		expect(applyPermissionChunk(opened, { type: 'permission_done', id: 'p1', decision: 'once' })).toBeNull();
	});

	it('leaves nothing open when a replay delivers the request and its close together', () => {
		const chunks = [request('p1'), { type: 'permission_done', id: 'p1', decision: 'deny' }];
		expect(chunks.reduce<OpenPermission | null>(applyPermissionChunk, null)).toBeNull();
	});

	it('ignores a close for another request', () => {
		const current = open('p2');
		expect(applyPermissionChunk(current, { type: 'permission_done', id: 'p1', decision: 'once' })).toBe(
			current
		);
	});

	it('ignores unrelated chunks', () => {
		const current = open('p1');
		expect(applyPermissionChunk(current, { type: 'notice' })).toBe(current);
		expect(applyPermissionChunk(null, { type: 'done' })).toBeNull();
	});
});

describe('permissionTitle', () => {
	it('names the server when there is one', () => {
		expect(permissionTitle('search', 'github')).toBe('search on github');
		expect(permissionTitle('write_file')).toBe('write_file');
	});
});
