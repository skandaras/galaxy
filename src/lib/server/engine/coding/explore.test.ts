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
let script: { calls: number; neverStops: boolean; answer: string; fail?: boolean };

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
		if (script.fail) {
			res.writeHead(500, { 'content-type': 'application/json' });
			res.end('{"error":"provider is down"}');
			return;
		}
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

	it('records the forwarded calls on the parent, so a reload still shows them', async () => {
		script = { calls: 0, neverStops: false, answer: 'Found it.' };
		const { parentJob, tool } = harness();
		const before = parentJob.lastChunkAt;
		await tool.execute({ question: 'Where?' });
		expect(parentJob.chunks.some((c) => c.type === 'tool' && c.name.startsWith('explore · '))).toBe(
			true
		);
		// And the parent counts as alive, which the abandoned-run watchdog reads.
		expect(parentJob.lastChunkAt).not.toBe(before);
	});

	it('drops the child step id, which the parent timeline has never heard of', async () => {
		// An unrecognised step id opens a blank orphan step; without one these
		// hang under the step holding the dispatch_explore call.
		script = { calls: 0, neverStops: false, answer: 'Found it.' };
		const { chunks, tool } = harness();
		await tool.execute({ question: 'Where?' });
		const forwarded = chunks.filter((c) => c.type === 'tool' && c.name.startsWith('explore · '));
		expect(forwarded.length).toBeGreaterThan(0);
		expect(forwarded.every((c) => c.type === 'tool' && c.stepId === undefined)).toBe(true);
	});

	it('reports a failed sub-agent as a failure, not as an empty answer', async () => {
		// runAgentLoop fails its own job rather than throwing, so a provider
		// outage used to come back as "found nothing" — which the parent would
		// reasonably act on.
		script = { calls: 0, neverStops: false, answer: '', fail: true };
		const { tool } = harness();
		await expect(tool.execute({ question: 'Where?' })).rejects.toThrow(/could not run/);
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

/** The chunks the Code page's agent pane is built from. */
describe('announcing itself to the parent run', () => {
	const agentChunks = (chunks: JobChunk[]) =>
		chunks.filter((c) => c.type === 'agent') as Extract<JobChunk, { type: 'agent' }>[];

	it('opens with a running row carrying a server start time', async () => {
		script = { calls: 0, neverStops: false, answer: 'Found it.' };
		const { chunks, tool } = harness();
		const before = Date.now();
		await tool.execute({ question: 'Where is a wired up?' });
		const first = agentChunks(chunks)[0];
		expect(first).toMatchObject({ kind: 'explore', status: 'running' });
		expect(first.label).toBe('Where is a wired up?');
		// Server time, because on replay after a reload every chunk arrives at
		// once and a client clock would call every sub-agent brand new.
		expect(first.startedAt).toBeGreaterThanOrEqual(before);
	});

	it('keeps one id throughout, so a replay converges', async () => {
		script = { calls: 0, neverStops: false, answer: 'Found it.' };
		const { chunks, tool } = harness();
		await tool.execute({ question: 'Where?' });
		const ids = new Set(agentChunks(chunks).map((c) => c.id));
		expect(ids.size).toBe(1);
		// And it really did update in place rather than announcing once.
		expect(agentChunks(chunks).length).toBeGreaterThan(1);
	});

	it('reports what it is doing as it works', async () => {
		script = { calls: 0, neverStops: false, answer: 'Found it.' };
		const { chunks, tool } = harness();
		await tool.execute({ question: 'Where?' });
		expect(agentChunks(chunks).some((c) => c.detail?.includes('read_file'))).toBe(true);
	});

	it('closes ok when it answered', async () => {
		script = { calls: 0, neverStops: false, answer: 'Found it.' };
		const { chunks, tool } = harness();
		await tool.execute({ question: 'Where?' });
		expect(agentChunks(chunks).at(-1)?.status).toBe('ok');
	});

	it('closes error when it could not', async () => {
		script = { calls: 0, neverStops: false, answer: '', fail: true };
		const { chunks, tool } = harness();
		await tool.execute({ question: 'Where?' }).catch(() => {});
		expect(agentChunks(chunks).at(-1)?.status).toBe('error');
	});

	it('caps a label that is really a paragraph', async () => {
		// Model-authored and unbounded, and this rides the wire on every update.
		script = { calls: 0, neverStops: false, answer: 'Found it.' };
		const { chunks, tool } = harness();
		await tool.execute({ question: 'x'.repeat(500) });
		expect(agentChunks(chunks)[0].label.length).toBe(140);
	});
});

describe('several at once', () => {
	it('is parallel-safe, so a turn can dispatch a few', () => {
		// Read-only, no shared state, its own job each time — and it is what makes
		// "one main agent and three sub-agents" a thing to look at.
		const { tool } = harness();
		expect(tool.parallelSafe).toBe(true);
	});

	it('gives each dispatch its own id and its own child chat', async () => {
		script = { calls: 0, neverStops: false, answer: 'Found it.' };
		const { parentJob, chunks } = harness();
		const ctx = context(parentJob);
		const [a, b] = [exploreTool(ctx), exploreTool(ctx)];
		await Promise.all([a.execute({ question: 'One?' }), b.execute({ question: 'Two?' })]);
		const ids = new Set(
			(chunks.filter((c) => c.type === 'agent') as Extract<JobChunk, { type: 'agent' }>[]).map(
				(c) => c.id
			)
		);
		expect(ids.size).toBe(2);
	});
});
