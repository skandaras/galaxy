import { beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir, db, runMigrations } from '$lib/server/db';
import { models, providers, taskConfigs } from '$lib/server/db/schema';
import { createJob, type JobChunk, type LiveJob } from '../jobs';
import { exploreTool, exploreToolDef, type ExploreContext } from './explore';
import { readOnlyCodingTools } from './tools';

const WS = 'workspaces/explore-test';
const abs = (...p: string[]) => join(dataDir, WS, ...p);

/**
 * A provider the sub-agent can actually reach. The mock answers on the second
 * round-trip unless told to keep calling tools, which is how the step cap is
 * exercised.
 */
let script: { calls: number; neverStops: boolean; answer: string };

beforeAll(() => {
	runMigrations();
	rmSync(abs(), { recursive: true, force: true });
	mkdirSync(abs('src'), { recursive: true });
	writeFileSync(abs('src', 'a.ts'), 'export const a = 1;\n');

	db.insert(providers)
		.values({
			id: 'p-explore',
			name: 'mock',
			kind: 'openai-compatible',
			baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
			apiKeyEnc: null,
			enabled: true,
			createdAt: new Date()
		})
		.onConflictDoNothing()
		.run();
	db.insert(models)
		.values({
			id: 'm-explore',
			providerId: 'p-explore',
			modelKey: 'mock-explorer',
			displayName: 'Mock Explorer',
			contextWindow: 8000,
			supportsTools: true,
			supportsVision: false,
			promptCostPerMTok: null,
			completionCostPerMTok: null,
			cacheMode: 'auto',
			enabled: true
		})
		.onConflictDoNothing()
		.run();
	db.insert(taskConfigs)
		.values({ task: 'subagent', systemPrompt: 'Explore.', primaryModelId: 'm-explore' })
		.onConflictDoUpdate({
			target: taskConfigs.task,
			set: { primaryModelId: 'm-explore', systemPrompt: 'Explore.' }
		})
		.run();
});

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Minimal OpenAI-compatible endpoint, enough for the agent loop. */
const server = createServer((req, res) => {
	let body = '';
	req.on('data', (c) => (body += c));
	req.on('end', () => {
		script.calls++;
		res.writeHead(200, { 'content-type': 'text/event-stream' });
		const send = (delta: Record<string, unknown>, finish?: string) =>
			res.write(
				`data: ${JSON.stringify({
					choices: [{ index: 0, delta, finish_reason: finish ?? null }]
				})}\n\n`
			);
		if (script.neverStops || script.calls === 1) {
			send({
				tool_calls: [
					{ index: 0, id: `c${script.calls}`, function: { name: 'read_file', arguments: '{"path":"src/a.ts"}' } }
				]
			});
			send({}, 'tool_calls');
		} else {
			send({ content: script.answer });
			send({}, 'stop');
		}
		res.write('data: [DONE]\n\n');
		res.end();
	});
});
server.listen(0);
// Never keep the test runner's event loop alive on this.
server.unref();

function context(parentJob: LiveJob): ExploreContext {
	return {
		workspaceRel: WS,
		mode: 'implement',
		repoUrl: 'https://example.invalid/x/y.git',
		baseBranch: 'main',
		workBranch: 'galaxy/session-x',
		parentJob,
		userId: 'u1',
		chatId: 'parent-chat'
	};
}

function harness() {
	const parentJob = createJob({
		chatId: 'parent-chat',
		userId: 'u1',
		task: 'coding',
		persist: false
	});
	const chunks: JobChunk[] = [];
	parentJob.subscribers.add((c) => chunks.push(c));
	return { parentJob, chunks, tool: exploreTool(context(parentJob)) };
}

describe('the sub-agent toolset', () => {
	const names = readOnlyCodingTools(context(createJob({
		chatId: 'x', userId: 'u1', task: 'coding', persist: false
	}))).map((t) => t.def.name);

	it('can only read', () => {
		expect(names).not.toContain('write_file');
		expect(names).not.toContain('edit_file');
		expect(names).not.toContain('bash');
		expect(names).not.toContain('git_commit');
		expect(names).not.toContain('open_pull_request');
	});

	it('cannot dispatch a sub-agent of its own', () => {
		// Recursion is prevented by the toolset, not by a depth counter — there
		// is no call it could make to spawn another.
		expect(names).not.toContain('dispatch_explore');
	});

	it('cannot ask the user anything, or reach the web', () => {
		expect(names).not.toContain('ask_user');
		expect(names).not.toContain('web_search');
		expect(names).not.toContain('fetch_url');
		expect(names).not.toContain('library_read');
	});

	it('does get the search tools that make it cheap', () => {
		expect(names).toEqual(
			expect.arrayContaining(['glob', 'grep_files', 'read_file', 'list_files'])
		);
	});
});

describe('dispatching one', () => {
	it('hands back the answer rather than what it read', async () => {
		script = { calls: 0, neverStops: false, answer: 'It is wired up in src/a.ts:1.' };
		const { tool } = harness();
		await expect(tool.execute({ question: 'Where is a wired up?' })).resolves.toBe(
			'It is wired up in src/a.ts:1.'
		);
	});

	it('shows the sub-agent working in the parent timeline', async () => {
		// Otherwise a dispatch is a silent pause of unknown length.
		script = { calls: 0, neverStops: false, answer: 'Found it.' };
		const { chunks, tool } = harness();
		await tool.execute({ question: 'Where?' });
		expect(chunks.some((c) => c.type === 'tool' && c.name.startsWith('explore · '))).toBe(true);
	});

	it('truncates an answer that is really a transcript', async () => {
		script = { calls: 0, neverStops: false, answer: 'x'.repeat(5_000) };
		const { tool } = harness();
		const out = await tool.execute({ question: 'Where?' });
		expect(out.length).toBeLessThan(2_200);
		expect(out).toContain('ask a narrower question');
	});

	it('stops at its step budget instead of exploring forever', async () => {
		// A sub-agent that wanders has spent more than the reading it saved.
		script = { calls: 0, neverStops: true, answer: '' };
		process.env.EXPLORE_MAX_STEPS = '3';
		const { tool } = harness();
		const out = await tool.execute({ question: 'Where?' });
		expect(script.calls).toBe(3);
		expect(out).toBeTruthy();
		delete process.env.EXPLORE_MAX_STEPS;
	});

	it('refuses an empty question', async () => {
		script = { calls: 0, neverStops: false, answer: 'x' };
		const { tool } = harness();
		await expect(tool.execute({ question: '  ' })).rejects.toThrow(/question is required/);
	});

	it('stops when the parent run is stopped', async () => {
		script = { calls: 0, neverStops: true, answer: '' };
		const { parentJob, tool } = harness();
		const pending = tool.execute({ question: 'Where?' });
		parentJob.controller.abort();
		await expect(pending).resolves.toBeTruthy();
	});

	it('never holds the parent chat, which would block the next message', async () => {
		// findRunningJobForChat scans live jobs by chat id; a child sharing the
		// parent's would be reported as the run in progress.
		script = { calls: 0, neverStops: false, answer: 'Found it.' };
		const { tool } = harness();
		await tool.execute({ question: 'Where?' });
		const { findRunningJobForChat } = await import('../jobs');
		expect(findRunningJobForChat('parent-chat')?.task).not.toBe('subagent');
	});
});

describe('how it is offered', () => {
	it('says plainly that it cannot change anything', () => {
		expect(exploreToolDef.description).toMatch(/never for making changes/);
	});

	it('says why it is worth using, in tokens', () => {
		expect(exploreToolDef.description).toMatch(/outside your context/);
	});
});
