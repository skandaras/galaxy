import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dataDir, runMigrations } from '$lib/server/db';
import { captureState, clearState, formatState, isDirty, loadState } from './state';

const WS = 'workspaces/state-test';
const abs = join(dataDir, WS);
const git = (cmd: string) =>
	execSync(`git -c user.email=t@t -c user.name=t ${cmd}`, { cwd: abs, stdio: 'pipe' });

beforeAll(() => {
	runMigrations();
	mkdirSync(abs, { recursive: true });
	git('init -q -b main');
	writeFileSync(join(abs, 'README.md'), '# repo\n');
	git('add -A');
	git('commit -qm init');
});

describe('captureState', () => {
	beforeEach(() => clearState('c1'));

	it('records which files were read and changed', async () => {
		const state = await captureState({
			chatId: 'c1',
			workspaceRel: WS,
			baseBranch: 'main',
			toolCalls: [
				{ name: 'read_file', summary: 'src/a.ts' },
				{ name: 'read_file', summary: 'src/b.ts' },
				{ name: 'edit_file', summary: 'src/a.ts' },
				{ name: 'bash', summary: 'npm test' }
			]
		});
		expect(state.filesRead).toEqual(['src/a.ts', 'src/b.ts']);
		expect(state.filesChanged).toEqual(['src/a.ts']);
	});

	it('accumulates across turns instead of replacing', async () => {
		const args = { chatId: 'c1', workspaceRel: WS, baseBranch: 'main' };
		await captureState({ ...args, toolCalls: [{ name: 'read_file', summary: 'one.ts' }] });
		const second = await captureState({
			...args,
			toolCalls: [{ name: 'read_file', summary: 'two.ts' }]
		});
		// The point of carrying state is that a later turn knows what earlier
		// turns already did, so nothing may be forgotten between legs.
		expect(second.filesRead).toEqual(['one.ts', 'two.ts']);
	});

	it('captures the real git state of the workspace', async () => {
		writeFileSync(join(abs, 'dirty.txt'), 'uncommitted\n');
		const state = await captureState({
			chatId: 'c1',
			workspaceRel: WS,
			baseBranch: 'main',
			toolCalls: []
		});
		expect(state.status).toContain('dirty.txt');
		expect(await isDirty(WS)).toBe(true);

		git('add -A');
		git('commit -qm "add dirty"');
		const clean = await captureState({
			chatId: 'c1',
			workspaceRel: WS,
			baseBranch: 'main',
			toolCalls: []
		});
		expect(clean.status).toBe('');
		expect(await isDirty(WS)).toBe(false);
	});

	it('round-trips through settings so the next leg can load it', async () => {
		await captureState({
			chatId: 'c1',
			workspaceRel: WS,
			baseBranch: 'main',
			toolCalls: [{ name: 'write_file', summary: 'src/new.ts' }]
		});
		expect(loadState('c1')?.filesChanged).toContain('src/new.ts');
		expect(loadState('other-chat')).toBeNull();
	});
});

describe('formatState', () => {
	it('is empty for a session that has not run yet', () => {
		expect(formatState(null)).toBe('');
	});

	it('tells the model what it already has, and not to re-read it', () => {
		const block = formatState({
			filesRead: ['a.ts'],
			filesChanged: ['b.ts'],
			status: ' M b.ts',
			commits: 'abc123 first',
			diffStat: ' b.ts | 2 +-',
			updatedAt: Date.now()
		});
		expect(block).toContain('Already read: a.ts');
		expect(block).toContain('Already changed: b.ts');
		expect(block).toContain('abc123 first');
		expect(block).toContain('Uncommitted changes');
		expect(block).toMatch(/Re-read a file only when/);
	});

	it('says so plainly when nothing is outstanding', () => {
		const block = formatState({
			filesRead: [],
			filesChanged: [],
			status: '',
			commits: '',
			diffStat: '',
			updatedAt: Date.now()
		});
		expect(block).toContain('Working tree is clean');
	});
});
