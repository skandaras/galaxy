import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db, runMigrations } from '$lib/server/db';
import { codeSessions, models, providers, taskConfigs } from '$lib/server/db/schema';
import { appendMessage, createChat } from '$lib/server/chats';
import { createJob } from '../jobs';
import { DelegationLedger } from './delegate';
import { captureState, loadState } from './state';
import {
	buildCodingSystemPrompt,
	codeAgentTools,
	continuationMessage,
	getOrchestrateModels,
	getSession,
	setOrchestrateModels,
	setSessionMode,
	splitPatch,
	turnModel,
	withWorkerWrites,
	type CodeSession
} from './session';

beforeAll(() => {
	runMigrations();
});

describe('getSession', () => {
	it('returns an existing session only to its owner', () => {
		const row = {
			chatId: 'session-owner-check',
			userId: 'session-owner',
			repoUrl: 'https://github.com/o/r.git',
			repoName: 'r',
			baseBranch: 'main',
			workBranch: 'galaxy/session-owner-check',
			workspaceRel: 'workspaces/session-owner-check',
			mode: 'plan' as const,
			prUrl: null,
			createdAt: new Date()
		};
		db.insert(codeSessions).values(row).run();

		expect(getSession(row.chatId, 'another-user')).toBeNull();
		expect(getSession(row.chatId, row.userId)).toMatchObject({
			chatId: row.chatId,
			userId: row.userId
		});
	});
});

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

describe('continuationMessage', () => {
	it('says what happened outside the transcript the next leg continues', () => {
		const text = continuationMessage(2, 3, 50, true);
		expect(text).toContain('Leg 2 of 3');
		expect(text).toContain('up to 50 more model turns');
		// The checkpoint is the one change the model did not make itself.
		expect(text).toContain('WIP checkpoint');
	});

	it('does not claim a checkpoint that did not happen', () => {
		expect(continuationMessage(2, 3, 50, false)).not.toContain('checkpoint');
	});

	it('keeps the opening the transcript and the smoke look for', () => {
		expect(continuationMessage(2, 3, 50, false)).toMatch(/^Continue from where you left off/);
	});
});

function sessionRow(mode: CodeSession['mode'], userId = `u-${randomUUID()}`): CodeSession {
	const chat = createChat({ userId, mode: 'code', title: 'repo' });
	const row: CodeSession = {
		chatId: chat.id,
		userId,
		repoUrl: 'https://github.com/o/r.git',
		repoName: 'r',
		baseBranch: 'main',
		workBranch: `galaxy/${chat.id}`,
		workspaceRel: `workspaces/${chat.id}`,
		mode,
		prUrl: null,
		createdAt: new Date()
	};
	db.insert(codeSessions).values(row).run();
	return row;
}

function addModel(id: string, opts: { tools?: boolean; enabled?: boolean } = {}) {
	const providerId = `p-${id}`;
	db.insert(providers)
		.values({
			id: providerId,
			name: providerId,
			kind: 'openai-compatible',
			baseUrl: 'http://example.invalid/v1',
			apiKeyEnc: null,
			enabled: true,
			createdAt: new Date()
		})
		.run();
	db.insert(models)
		.values({
			id,
			providerId,
			modelKey: id,
			displayName: id,
			contextWindow: 8000,
			supportsTools: opts.tools ?? true,
			supportsVision: false,
			promptCostPerMTok: null,
			completionCostPerMTok: null,
			cacheMode: 'auto',
			enabled: opts.enabled ?? true
		})
		.run();
}

function configure(task: string, primaryModelId: string) {
	const row = { task, systemPrompt: '', promptOverride: null, options: null, primaryModelId };
	db.insert(taskConfigs).values(row).onConflictDoUpdate({ target: taskConfigs.task, set: { primaryModelId } }).run();
}

describe('setSessionMode', () => {
	it('keeps the approved plan when a plan session moves to orchestrate', () => {
		const session = sessionRow('plan');
		appendMessage(session.chatId, { role: 'assistant', content: '1. Add the field\n2. Test it' });
		setSessionMode(session, 'orchestrate');
		expect(getSession(session.chatId, session.userId)?.mode).toBe('orchestrate');
		expect(loadState(session.chatId)?.approvedPlan).toBe('1. Add the field\n2. Test it');
	});
});

describe('per-session tier models', () => {
	it('ignores an id that no longer resolves, so the Admin default applies', () => {
		const { chatId } = sessionRow('orchestrate');
		addModel('om-good');
		addModel('om-off', { enabled: false });
		addModel('om-notools', { tools: false });
		setOrchestrateModels(chatId, { tier1: 'om-good', tier2: 'om-gone' });
		expect(getOrchestrateModels(chatId)).toEqual({ tier1: 'om-good' });
		setOrchestrateModels(chatId, { tier1: 'om-off', tier2: 'om-notools' });
		expect(getOrchestrateModels(chatId)).toEqual({});
	});

	it('clears one tier on null and keeps the other', () => {
		const { chatId } = sessionRow('orchestrate');
		addModel('om-a');
		addModel('om-b');
		setOrchestrateModels(chatId, { tier1: 'om-a', tier2: 'om-b' });
		setOrchestrateModels(chatId, { tier1: null });
		expect(getOrchestrateModels(chatId)).toEqual({ tier2: 'om-b' });
	});
});

describe('orchestrate system prompt', () => {
	it('carries its own marker and neither of the others', () => {
		const text = buildCodingSystemPrompt('base', sessionRow('orchestrate'));
		expect(text).toContain('ORCHESTRATE mode');
		expect(text).not.toContain('PLAN mode');
		expect(text).not.toContain('IMPLEMENT mode');
	});

	it('leaves plan and implement with their own single marker', () => {
		const plan = buildCodingSystemPrompt('base', sessionRow('plan'));
		const implement = buildCodingSystemPrompt('base', sessionRow('implement'));
		expect(plan).toContain('PLAN mode');
		expect(plan).not.toContain('ORCHESTRATE mode');
		expect(implement).toContain('IMPLEMENT mode');
		expect(implement).not.toContain('ORCHESTRATE mode');
	});
});

describe('orchestrate turn setup', () => {
	it('offers delegation and shipping and nothing that writes code', () => {
		const session = sessionRow('orchestrate');
		const job = createJob({ chatId: session.chatId, userId: session.userId, task: 'coding', persist: false });
		const names = codeAgentTools({
			session,
			job,
			userId: session.userId,
			chatId: session.chatId,
			ledger: new DelegationLedger()
		}).map((t) => t.def.name);
		for (const n of ['dispatch_task', 'dispatch_explore', 'git_commit']) expect(names).toContain(n);
		for (const n of ['write_file', 'edit_file', 'bash']) expect(names).not.toContain(n);
	});

	it('does not offer dispatch_task outside orchestrate mode', () => {
		const session = sessionRow('implement');
		const job = createJob({ chatId: session.chatId, userId: session.userId, task: 'coding', persist: false });
		const names = codeAgentTools({
			session,
			job,
			userId: session.userId,
			chatId: session.chatId,
			ledger: new DelegationLedger()
		}).map((t) => t.def.name);
		expect(names).not.toContain('dispatch_task');
		expect(names).toContain('write_file');
	});

	it('takes the model from coding-orchestrator even when the page sends one', () => {
		addModel('orch-model');
		addModel('picker-model');
		addModel('coding-model');
		configure('coding-orchestrator', 'orch-model');
		configure('coding', 'coding-model');
		const o = turnModel('orchestrate', 'picker-model');
		expect(o.choice.model.id).toBe('orch-model');
		expect(o.loopTask).toBe('coding-orchestrator');
		const i = turnModel('implement', 'picker-model');
		expect(i.choice.model.id).toBe('picker-model');
		expect(i.loopTask).toBe('coding');
		expect(turnModel('plan').choice.model.id).toBe('coding-model');
	});

	it('refuses an orchestrator model that cannot call tools', () => {
		addModel('orch-notools', { tools: false });
		configure('coding-orchestrator', 'orch-notools');
		expect(() => turnModel('orchestrate')).toThrow(/tool calling/);
		db.update(taskConfigs).set({ primaryModelId: null }).where(eq(taskConfigs.task, 'coding-orchestrator')).run();
	});
});

describe('worker writes in session state', () => {
	it('reach filesChanged without touching the leg trace', async () => {
		const chatId = `ledger-${randomUUID()}`;
		const ledger = new DelegationLedger();
		ledger.add(['README.md', 'src/a.ts']);
		const own = [{ name: 'read_file', summary: 'package.json', status: 'ok' as const }];
		const calls = withWorkerWrites(own, ledger.drain());
		// The input list is the one the saved message trace was built from.
		expect(own).toHaveLength(1);
		const state = await captureState({
			chatId,
			workspaceRel: 'workspaces/not-a-repo',
			baseBranch: 'main',
			toolCalls: calls
		});
		expect(state.filesChanged).toEqual(['README.md', 'src/a.ts']);
		expect(state.filesRead).toEqual(['package.json']);
		expect(ledger.drain()).toEqual([]);
	});
});
