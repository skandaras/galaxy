import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dataDir, runMigrations } from '$lib/server/db';
import {
	captureState,
	clearState,
	formatState,
	isDirty,
	loadState,
	setApprovedPlan,
	setPlan
} from './state';

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

describe('the approved plan', () => {
	const CHAT = 'plan-chat';

	beforeEach(() => clearState(CHAT));

	it('is remembered once the plan is approved', () => {
		setApprovedPlan(CHAT, '1. Add the tool\n2. Wire it up');
		expect(loadState(CHAT)?.approvedPlan).toContain('Wire it up');
	});

	it('ignores an empty plan rather than storing a blank one', () => {
		setApprovedPlan(CHAT, '   \n  ');
		expect(loadState(CHAT)).toBeNull();
	});

	it('survives the state being rebuilt on a later leg', async () => {
		// captureState builds a fresh object every leg, so anything not carried
		// forward by name is silently dropped — which is how the plan would have
		// gone missing halfway through implementing it.
		setApprovedPlan(CHAT, 'Do the thing');
		await captureState({
			chatId: CHAT,
			workspaceRel: WS,
			baseBranch: 'main',
			toolCalls: [{ name: 'read_file', summary: 'a.ts' }]
		});
		expect(loadState(CHAT)?.approvedPlan).toBe('Do the thing');
		expect(loadState(CHAT)?.filesRead).toEqual(['a.ts']);
	});

	it('leads the state block, and says it is what is being built', () => {
		setApprovedPlan(CHAT, 'Do the thing');
		const block = formatState(loadState(CHAT));
		expect(block).toContain('[Approved plan');
		expect(block.indexOf('[Approved plan')).toBeLessThan(block.indexOf('[Session state'));
		expect(block).toContain('Do the thing');
	});

	it('is absent from the block when no plan was approved', () => {
		expect(formatState({
			filesRead: [],
			filesChanged: [],
			status: '',
			commits: '',
			diffStat: '',
			updatedAt: 0
		})).not.toContain('Approved plan');
	});

	it('truncates a plan that is really a document', () => {
		setApprovedPlan(CHAT, 'x'.repeat(20_000));
		expect(loadState(CHAT)?.approvedPlan?.length).toBe(6_000);
	});
});

describe('the working plan', () => {
	const CHAT = 'working-plan-chat';

	beforeEach(() => clearState(CHAT));

	it('is kept and rendered as a checklist', () => {
		setPlan(CHAT, [
			{ text: 'Read the loop', status: 'done' },
			{ text: 'Add the helper', status: 'doing' },
			{ text: 'Write tests', status: 'todo' }
		]);
		const block = formatState(loadState(CHAT));
		expect(block).toContain('[x] Read the loop');
		expect(block).toContain('[~] Add the helper');
		expect(block).toContain('[ ] Write tests');
	});

	it('survives the state being rebuilt on a later leg', async () => {
		// The whole point is tracking work *within* a long run, which spans legs.
		setPlan(CHAT, [{ text: 'Add the helper', status: 'doing' }]);
		await captureState({
			chatId: CHAT,
			workspaceRel: WS,
			baseBranch: 'main',
			toolCalls: []
		});
		expect(loadState(CHAT)?.plan).toEqual([{ text: 'Add the helper', status: 'doing' }]);
	});

	it('replaces the list rather than appending to it', () => {
		setPlan(CHAT, [{ text: 'One', status: 'todo' }]);
		setPlan(CHAT, [{ text: 'Two', status: 'done' }]);
		expect(loadState(CHAT)?.plan).toEqual([{ text: 'Two', status: 'done' }]);
	});

	it('caps a checklist that has become a backlog', () => {
		setPlan(
			CHAT,
			Array.from({ length: 50 }, (_, i) => ({ text: `step ${i}`, status: 'todo' as const }))
		);
		expect(loadState(CHAT)?.plan).toHaveLength(20);
	});

	it('is absent from the block when there is no plan', () => {
		expect(
			formatState({
				filesRead: [],
				filesChanged: [],
				status: '',
				commits: '',
				diffStat: '',
				updatedAt: 0
			})
		).not.toContain('Working plan');
	});
});
