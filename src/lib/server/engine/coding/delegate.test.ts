import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq, inArray } from 'drizzle-orm';
import { dataDir, db, runMigrations } from '$lib/server/db';
import { models, providers, taskConfigs, usageLog } from '$lib/server/db/schema';
import { createJob, type JobChunk, type LiveJob } from '../jobs';
import { DEFAULT_TASK_DESCRIPTIONS } from '../engine';
import { delegateTool, DelegationLedger, type DelegateContext } from './delegate';
import { treeFingerprint } from './snapshot';

const WS = 'workspaces/delegate-test';
const abs = (...p: string[]) => join(dataDir, WS, ...p);
const git = (cmd: string) =>
	execSync(`git ${cmd}`, { cwd: abs(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** One scripted worker run: the tool calls it makes, one per round-trip, then its closing text. */
interface Run {
	calls?: { name: string; args: Record<string, unknown> }[];
	text?: string;
	/** Keep calling `bash true` until the step cap stops it. */
	neverStops?: boolean;
	fail?: boolean;
	/** Runs inside the provider when this run's first request arrives. */
	onStart?: () => void;
}

interface Seen {
	model: string;
	tools: string[];
	user: string;
	run: number;
	round: number;
}

let runs: Run[] = [];
let seen: Seen[] = [];
let runCount = 0;
/** The loop retries a failed call as a fresh round-0 request, which must not start a new scripted run. */
let lastFailed = false;

const server = createServer((req, res) => {
	let body = '';
	req.on('data', (c) => (body += c));
	req.on('end', () => {
		const parsed = JSON.parse(body) as {
			model: string;
			messages: { role: string; content?: unknown }[];
			tools?: { function: { name: string } }[];
		};
		const round = parsed.messages.filter((m) => m.role === 'tool').length;
		if (round === 0 && !lastFailed) runCount++;
		lastFailed = false;
		const run = runCount - 1;
		const script = runs[run] ?? { text: 'done' };
		const user = parsed.messages.find((m) => m.role === 'user')?.content;
		seen.push({
			model: parsed.model,
			tools: (parsed.tools ?? []).map((t) => t.function.name),
			user: typeof user === 'string' ? user : JSON.stringify(user),
			run,
			round
		});
		if (round === 0) script.onStart?.();
		if (script.fail) {
			lastFailed = true;
			res.writeHead(500, { 'content-type': 'application/json' });
			res.end('{"error":"provider is down"}');
			return;
		}
		res.writeHead(200, { 'content-type': 'text/event-stream' });
		const send = (delta: Record<string, unknown>, finish?: string) =>
			res.write(
				`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish ?? null }] })}\n\n`
			);
		const call = script.neverStops
			? { name: 'bash', args: { command: 'true' } }
			: script.calls?.[round];
		if (call) {
			send({
				tool_calls: [
					{ index: 0, id: `c${run}-${round}`, function: { name: call.name, arguments: JSON.stringify(call.args) } }
				]
			});
			send({}, 'tool_calls');
		} else {
			send({ content: script.text ?? 'Done.' });
			send({}, 'stop');
		}
		res.write('data: [DONE]\n\n');
		res.end();
	});
});
server.listen(0);
server.unref();

beforeAll(() => {
	runMigrations();
	const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
	db.insert(providers)
		.values({
			id: 'p-delegate',
			name: 'mock',
			kind: 'openai-compatible',
			baseUrl,
			apiKeyEnc: null,
			enabled: true,
			createdAt: new Date()
		})
		.onConflictDoNothing()
		.run();
	for (const [id, key] of [
		['m-t1', 'mock-t1'],
		['m-t2', 'mock-t2'],
		['m-other', 'mock-other']
	]) {
		db.insert(models)
			.values({
				id,
				providerId: 'p-delegate',
				modelKey: key,
				displayName: key,
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
	}
	for (const [task, model] of [
		['coding-tier1', 'm-t1'],
		['coding-tier2', 'm-t2']
	]) {
		db.insert(taskConfigs)
			.values({ task, systemPrompt: 'Work.', primaryModelId: model })
			.onConflictDoUpdate({ target: taskConfigs.task, set: { primaryModelId: model } })
			.run();
	}
});

beforeEach(() => {
	runs = [];
	seen = [];
	runCount = 0;
	lastFailed = false;
	rmSync(abs(), { recursive: true, force: true });
	mkdirSync(abs('src'), { recursive: true });
	git('init -q -b main');
	git('config user.email t@example.invalid');
	git('config user.name Test');
	writeFileSync(abs('.gitignore'), 'cache/\n');
	writeFileSync(abs('src', 'a.txt'), 'one\n');
	git('add -A');
	git('commit -q -m first');
});

afterEach(() => {
	delete process.env.TIER1_MAX_STEPS;
	delete process.env.TIER2_MAX_STEPS;
});

const CHECK = 'grep -q done src/a.txt';
const write = (content: string, path = 'src/a.txt') => ({
	name: 'write_file',
	args: { path, content }
});

function harness(models?: DelegateContext['models'], persist = false) {
	const parentJob: LiveJob = createJob({
		chatId: 'parent-chat',
		userId: 'u1',
		task: 'coding',
		persist
	});
	const chunks: JobChunk[] = [];
	parentJob.subscribers.add((c) => chunks.push(c));
	const ledger = new DelegationLedger();
	const ctx: DelegateContext = {
		workspaceRel: WS,
		mode: 'orchestrate',
		repoUrl: 'https://example.invalid/x/y.git',
		baseBranch: 'main',
		workBranch: 'galaxy/session-x',
		parentJob,
		userId: 'u1',
		chatId: 'parent-chat',
		ledger,
		models
	};
	return { parentJob, chunks, ledger, tool: delegateTool(ctx) };
}

type Agent = Extract<JobChunk, { type: 'agent' }>;
const agents = (chunks: JobChunk[]) => chunks.filter((c): c is Agent => c.type === 'agent');

describe('a task that passes', () => {
	it('passes first time and records what the worker wrote', async () => {
		runs = [{ calls: [write('done\n')], text: 'Wrote the word.' }];
		const { tool, ledger } = harness();
		const out = await tool.execute({ tier: 1, task: 'Put done in a.txt', check: CHECK });
		expect(out).toContain('Task passed: finished by tier 1 after 1 worker run.');
		expect(out).toContain('Baseline: failed as expected (exit 1)');
		expect(out).toContain('Worker report: Wrote the word.');
		expect(out).toMatch(/Changed:\n[\s\S]*src\/a\.txt/);
		expect(out).toContain('Read the diff before you commit');
		expect(ledger.drain()).toEqual(['src/a.txt']);
		expect(ledger.drain()).toEqual([]);
		expect(readFileSync(abs('src', 'a.txt'), 'utf8')).toBe('done\n');
	});

	it('retries with the check output when the first run fails', async () => {
		runs = [{ calls: [write('nope\n')] }, { calls: [write('done\n')] }];
		const { tool } = harness();
		const out = await tool.execute({
			tier: 1,
			task: 'Put done in a.txt',
			check: `${CHECK} || { echo MISSING-THE-WORD; exit 1; }`
		});
		expect(out).toContain('after 2 worker runs');
		const second = seen.find((s) => s.run === 1)!;
		expect(second.user).toContain('MISSING-THE-WORD');
		expect(second.user).toContain('BEGIN COMMAND OUTPUT');
		expect(second.user).toContain('src/a.txt');
		expect(seen.find((s) => s.run === 0)!.user).not.toContain('earlier worker');
	});

	it('moves from tier 2 to tier 1 and keeps one announcement row', async () => {
		runs = [{ calls: [write('x\n')] }, { calls: [write('y\n')] }, { calls: [write('z\n')] }, { calls: [write('done\n')] }];
		const { tool, chunks } = harness();
		const out = await tool.execute({ tier: 2, task: 'Put done in a.txt', check: CHECK });
		expect(out).toContain('finished by tier 1 after 4 worker runs, escalated from tier 2');
		expect(seen.filter((s) => s.round === 0).map((s) => s.model)).toEqual([
			'mock-t2',
			'mock-t2',
			'mock-t1',
			'mock-t1'
		]);
		const rows = agents(chunks);
		expect(new Set(rows.map((r) => r.id)).size).toBe(1);
		const kinds = rows.map((r) => r.kind);
		expect(kinds[0]).toBe('tier2');
		expect(kinds.at(-1)).toBe('tier1');
		expect(kinds.indexOf('tier1')).toBeGreaterThan(kinds.lastIndexOf('tier2') - 1);
		expect(rows.some((r) => r.detail === 'escalating to tier 1')).toBe(true);
		expect(rows.some((r) => r.detail === 'check failed, retrying')).toBe(true);
		expect(rows.at(-1)).toMatchObject({ status: 'ok', detail: 'check passed' });
	});

	it('allows a check that already passes when regression is set', async () => {
		runs = [{ calls: [write('one\n', 'src/b.txt')] }];
		const { tool } = harness();
		const out = await tool.execute({
			tier: 1,
			task: 'Add b.txt without breaking a.txt',
			check: 'grep -q one src/a.txt',
			regression: true
		});
		expect(out).toContain('Baseline: passed (regression check)');
		expect(seen.length).toBeGreaterThan(0);
	});
});

describe('a task that fails', () => {
	it('reverts to the start of the task and keeps files an earlier task left', async () => {
		writeFileSync(abs('src', 'earlier.txt'), 'from an earlier task\n');
		writeFileSync(abs('src', 'a.txt'), 'one edited\n');
		const t0 = (await treeFingerprint(WS))!;
		const statusBefore = git('status --porcelain=v1 -uall');
		runs = [
			{ calls: [write('x\n'), write('junk\n', 'src/new.txt')] },
			{ calls: [write('y\n')] }
		];
		const { tool, ledger } = harness();
		const out = await tool.execute({ tier: 1, task: 'Put done in a.txt', check: CHECK });
		expect(out).toContain('Task failed after 2 worker runs on tier 1.');
		expect(out).toContain('Check exit 1:');
		expect(out).toContain('Attempted changes:');
		expect(out).toContain('The changes were reverted. Split the task smaller');
		expect((await treeFingerprint(WS))!.tree).toBe(t0.tree);
		expect(readFileSync(abs('src', 'earlier.txt'), 'utf8')).toBe('from an earlier task\n');
		expect(existsSync(abs('src', 'new.txt'))).toBe(false);
		expect(git('status --porcelain=v1 -uall')).toBe(statusBefore);
		expect(ledger.drain()).toEqual([]);
	});

	it('names every tier it tried', async () => {
		const { tool } = harness();
		const out = await tool.execute({ tier: 2, task: 'Put done in a.txt', check: CHECK });
		expect(out).toContain('Task failed after 4 worker runs on tiers 2, 1.');
	});

	it('throws when the provider fails, and puts the tree back', async () => {
		runs = [{ calls: [write('x\n')] }, { fail: true }];
		const { tool } = harness();
		await expect(tool.execute({ tier: 1, task: 'Put done in a.txt', check: CHECK })).rejects.toThrow(
			/could not run/
		);
		expect(readFileSync(abs('src', 'a.txt'), 'utf8')).toBe('one\n');
	});

	it('stops the ladder when the parent run is stopped, and leaves the tree as it is', async () => {
		const { tool, parentJob } = harness();
		runs = [{ calls: [write('x\n')], onStart: () => parentJob.controller.abort() }];
		await expect(tool.execute({ tier: 2, task: 'Put done in a.txt', check: CHECK })).rejects.toThrow(
			/stopped/
		);
		expect(new Set(seen.map((s) => s.run)).size).toBe(1);
	});
});

describe('a check that is turned away', () => {
	it('refuses one that already passes, before any model call', async () => {
		const { tool } = harness();
		await expect(
			tool.execute({ tier: 1, task: 'Do nothing', check: 'grep -q one src/a.txt' })
		).rejects.toThrow(/passes before any work/);
		expect(seen).toHaveLength(0);
	});

	it('refuses a regression check that fails', async () => {
		const { tool } = harness();
		await expect(
			tool.execute({ tier: 1, task: 'Refactor', check: CHECK, regression: true })
		).rejects.toThrow(/regression check has to pass/);
		expect(seen).toHaveLength(0);
	});

	it('refuses a command that does not exist', async () => {
		const { tool } = harness();
		await expect(
			tool.execute({ tier: 1, task: 'Do it', check: 'no-such-command-xyz --run' })
		).rejects.toThrow(/could not run \(exit 127/);
		expect(seen).toHaveLength(0);
	});

	it('refuses a check that writes a tracked-eligible file, and removes it', async () => {
		const { tool } = harness();
		await expect(
			tool.execute({ tier: 1, task: 'Do it', check: `echo x > made.txt; ${CHECK}` })
		).rejects.toThrow(/wrote files/);
		expect(existsSync(abs('made.txt'))).toBe(false);
		expect(seen).toHaveLength(0);
	});

	it('refuses a check that times out', async () => {
		process.env.TASK_CHECK_TIMEOUT_MS = '400';
		try {
			const { tool } = harness();
			await expect(tool.execute({ tier: 1, task: 'Do it', check: 'sleep 5' })).rejects.toThrow(/timed out/);
			expect(seen).toHaveLength(0);
		} finally {
			delete process.env.TASK_CHECK_TIMEOUT_MS;
		}
	});

	it('refuses malformed arguments in words the orchestrator can act on', async () => {
		const { tool } = harness();
		await expect(tool.execute({ tier: 3, task: 'x', check: 'true' })).rejects.toThrow(/tier must be 1 or 2/);
		await expect(tool.execute({ tier: 1, task: ' ', check: 'true' })).rejects.toThrow(/task is required/);
		await expect(tool.execute({ tier: 1, task: 'x'.repeat(4001), check: 'true' })).rejects.toThrow(/Split it/);
		await expect(tool.execute({ tier: 1, task: 'x', check: '' })).rejects.toThrow(/check is required/);
		await expect(tool.execute({ tier: 1, task: 'x', check: 'x'.repeat(501) })).rejects.toThrow(/shorter/);
		await expect(tool.execute({ tier: 1, task: 'x', check: 'true\nfalse' })).rejects.toThrow(/single line/);
		expect(seen).toHaveLength(0);
	});
});

describe('what the worker gets and does', () => {
	it('can edit and run commands, and cannot ship, plan or dispatch', async () => {
		runs = [{ calls: [write('done\n')] }];
		const { tool } = harness();
		await tool.execute({ tier: 1, task: 'Put done in a.txt', check: CHECK });
		const names = seen[0].tools;
		expect(names).toEqual(expect.arrayContaining(['write_file', 'edit_file', 'bash', 'read_file']));
		for (const banned of ['git_commit', 'git_push', 'open_pull_request', 'update_plan', 'dispatch_task', 'dispatch_explore']) {
			expect(names).not.toContain(banned);
		}
	});

	it('is told the task, the files and the check', async () => {
		runs = [{ calls: [write('done\n')] }];
		const { tool } = harness();
		await tool.execute({ tier: 1, task: 'Put done in a.txt', files: ['src/a.txt'], check: CHECK });
		expect(seen[0].user).toContain('Put done in a.txt');
		expect(seen[0].user).toContain('- src/a.txt');
		expect(seen[0].user).toContain(CHECK);
	});

	it('forwards the worker tool calls on the parent as tier rows', async () => {
		runs = [{ calls: [write('done\n')] }];
		const { tool, chunks } = harness();
		await tool.execute({ tier: 2, task: 'Put done in a.txt', check: CHECK });
		expect(chunks.some((c) => c.type === 'tool' && c.name === 'tier 2 · write_file')).toBe(true);
	});

	it('follows the step caps', async () => {
		process.env.TIER1_MAX_STEPS = '3';
		process.env.TIER2_MAX_STEPS = '2';
		runs = [{ neverStops: true }, { neverStops: true }, { neverStops: true }, { neverStops: true }];
		const { tool } = harness();
		await tool.execute({ tier: 2, task: 'Put done in a.txt', check: CHECK });
		const perRun = [0, 1, 2, 3].map((r) => seen.filter((s) => s.run === r).length);
		expect(perRun).toEqual([2, 2, 3, 3]);
	});

	it('uses the per-session model in place of the Admin default', async () => {
		runs = [{ calls: [write('done\n')] }];
		const { tool } = harness({ tier1: 'm-other' });
		await tool.execute({ tier: 1, task: 'Put done in a.txt', check: CHECK });
		expect(seen[0].model).toBe('mock-other');
	});

	it('logs worker usage under the tier tasks', async () => {
		runs = [{ calls: [write('x\n')] }, { calls: [write('done\n')] }, { calls: [write('done\n')] }];
		db.delete(usageLog).where(inArray(usageLog.task, ['coding-tier1', 'coding-tier2'])).run();
		const { tool } = harness();
		await tool.execute({ tier: 2, task: 'Put done in a.txt', check: CHECK });
		const rows = db
			.select()
			.from(usageLog)
			.where(inArray(usageLog.task, ['coding-tier1', 'coding-tier2']))
			.all();
		expect(new Set(rows.map((r) => r.task))).toEqual(new Set(['coding-tier2']));
		expect(rows.every((r) => !r.chatId?.includes('parent-chat'))).toBe(true);
	});
});

describe('how it is offered', () => {
	const original = () => db.select().from(taskConfigs).where(eq(taskConfigs.task, 'coding-tier2')).get();

	it('is not parallel-safe and describes a call by its task', () => {
		const { tool } = harness();
		expect(tool.parallelSafe).toBeFalsy();
		expect(tool.describe!({ task: 'y'.repeat(200) })).toHaveLength(80);
	});

	it('lists both tiers in its live description', () => {
		const { tool } = harness();
		expect(tool.def.name).toBe('dispatch_task');
		expect(tool.def.description).toContain(`Tier 1: ${DEFAULT_TASK_DESCRIPTIONS['coding-tier1']}`);
		expect(tool.def.description).toContain(`Tier 2: ${DEFAULT_TASK_DESCRIPTIONS['coding-tier2']}`);
		expect(tool.def.parameters).toMatchObject({ required: ['tier', 'task', 'check'] });
	});

	it('reflects a description override on the task config', () => {
		const before = original()?.options ?? null;
		db.update(taskConfigs)
			.set({ options: { description: 'Only tidy-ups of one line.' } })
			.where(eq(taskConfigs.task, 'coding-tier2'))
			.run();
		try {
			const { tool } = harness();
			expect(tool.def.description).toContain('Tier 2: Only tidy-ups of one line.');
			expect(tool.def.description).not.toContain(DEFAULT_TASK_DESCRIPTIONS['coding-tier2']);
		} finally {
			db.update(taskConfigs).set({ options: before }).where(eq(taskConfigs.task, 'coding-tier2')).run();
		}
	});
});

describe('what it records', () => {
	it('keeps the task and the check out of the event', async () => {
		const { events } = await import('$lib/server/db/schema');
		runs = [{ calls: [write('done\n')] }];
		const { tool } = harness(undefined, false);
		await tool.execute({ tier: 1, task: 'SECRET-TASK-TEXT', check: `${CHECK} # SECRET-CHECK-TEXT` });
		const stored = db.select().from(events).where(eq(events.name, 'delegate.task')).all();
		expect(JSON.stringify(stored)).not.toContain('SECRET-');
	});
});
