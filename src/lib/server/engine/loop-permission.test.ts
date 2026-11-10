import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '$lib/server/db';
import type { ModelChoice } from '$lib/server/providers/registry';
import type { ProviderMessage, StreamEvent } from '$lib/server/providers/types';
import { createJob, subscribeJob, type JobChunk, type LiveJob } from './jobs';
import { runAgentLoop, type LoopTool } from './loop';
import { answerPermission } from './permissions';

/**
 * A tool marked with `permission` stops the run for a yes before it executes.
 * MCP tools are the only ones marked today.
 */

beforeAll(() => {
	runMigrations();
});

const jobs: LiveJob[] = [];
afterEach(() => {
	for (const job of jobs.splice(0)) job.controller.abort();
});

let n = 0;

/** One call to `probe`, answering the permission request with `decision`, then a reply. */
async function runWith(decision: 'once' | 'deny') {
	const received: Record<string, unknown>[] = [];
	const seen: ProviderMessage[][] = [];
	let call = 0;
	const choice = {
		model: {
			modelKey: 'mock',
			displayName: 'Mock',
			supportsTools: true,
			supportsVision: false,
			supportsReasoning: false,
			reasoningMode: 'auto',
			promptCostPerMTok: null,
			completionCostPerMTok: null
		},
		provider: {},
		adapter: {
			async *stream(req: { messages: ProviderMessage[] }): AsyncGenerator<StreamEvent> {
				seen.push(structuredClone(req.messages));
				if (call++ === 0) {
					yield { type: 'tool_calls', calls: [{ id: 'c1', name: 'probe', arguments: '{"path":"/x"}' }] };
					yield { type: 'done', finishReason: 'tool_calls' };
					return;
				}
				yield { type: 'text', delta: 'Done.' };
				yield { type: 'done', finishReason: 'stop' };
			},
			complete: async () => ({ text: '', usage: null }),
			listModels: async () => []
		}
	} as unknown as ModelChoice;
	const probe: LoopTool = {
		def: { name: 'probe', description: 'records its arguments', parameters: { type: 'object' } },
		describe: (a) => String(a.path ?? ''),
		permission: { key: `loop-perm:${++n}`, label: 'files__probe', server: 'Files' },
		execute: async (args) => {
			received.push(args);
			return 'ran';
		}
	};
	const chatId = `perm-loop-${n}`;
	const job = createJob({ chatId, userId: 'u1', task: 'chat', persist: false });
	jobs.push(job);
	const chunks: JobChunk[] = [];
	subscribeJob(job, (c) => {
		chunks.push(c);
		if (c.type === 'permission') answerPermission(c.id, 'u1', decision);
	});
	await runAgentLoop({
		job,
		task: 'chat',
		userId: 'u1',
		chatId,
		persist: false,
		primary: choice,
		backup: null,
		tools: [probe],
		maxIterations: 4,
		buildMessages: () => [{ role: 'system', content: 'You are a test agent.' }],
		onDone: () => {}
	});
	const toolReply = seen[1]?.find((m) => m.role === 'tool');
	return { received, chunks, toolReply: String(toolReply?.content ?? '') };
}

describe('a tool that needs permission', () => {
	it('runs when the person allows it', async () => {
		const { received, toolReply, chunks } = await runWith('once');
		expect(received).toEqual([{ path: '/x' }]);
		expect(toolReply).toBe('ran');
		expect(chunks.find((c) => c.type === 'permission')).toMatchObject({
			tool: 'files__probe',
			server: 'Files',
			summary: '/x'
		});
	});

	it('is not run when the person declines, and the model is told so', async () => {
		const { received, toolReply, chunks } = await runWith('deny');
		expect(received).toHaveLength(0);
		expect(toolReply).toContain('The person declined to let files__probe run');
		expect(toolReply).toContain('Do not retry it');
		expect(chunks.find((c) => c.type === 'tool' && c.status === 'error')).toBeTruthy();
	});
});
