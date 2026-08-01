import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, runMigrations } from '$lib/server/db';
import { events, usageLog } from '$lib/server/db/schema';
import type { ModelChoice } from '$lib/server/providers/registry';
import type { ChatRequest, ProviderAdapter, StreamEvent } from '$lib/server/providers/types';
import { createJob, type JobChunk } from './jobs';
import { runAgentLoop } from './loop';

const CHAT_ID = 'chat-under-test';

/** A provider that is simply down — the shape of a turn that never answers. */
function deadAdapter(): ProviderAdapter {
	return {
		// eslint-disable-next-line require-yield
		async *stream(_req: ChatRequest): AsyncGenerator<StreamEvent> {
			throw new Error('ECONNREFUSED talking to the provider');
		},
		complete: async () => ({ text: '', usage: null }),
		listModels: async () => []
	};
}

const deadChoice = {
	adapter: deadAdapter(),
	model: { id: 'm1', modelKey: 'mock/dead', displayName: 'Dead', supportsVision: false }
} as unknown as ModelChoice;

async function runFailingTurn(persist: boolean): Promise<JobChunk[]> {
	const job = createJob({ chatId: CHAT_ID, userId: 'u1', task: 'chat', persist });
	const chunks: JobChunk[] = [];
	job.subscribers.add((c) => chunks.push(c));
	await runAgentLoop({
		job,
		task: 'chat',
		userId: 'u1',
		chatId: CHAT_ID,
		persist,
		primary: deadChoice,
		backup: null,
		tools: [],
		maxIterations: 2,
		buildMessages: () => [],
		onDone: () => undefined
	});
	return chunks;
}

const turnEvents = () =>
	db
		.select()
		.from(events)
		.where(and(eq(events.task, 'chat'), eq(events.name, 'chat.turn')))
		.all();

beforeAll(() => {
	runMigrations();
});

beforeEach(() => {
	db.delete(events).run();
	db.delete(usageLog).run();
});

describe('a turn that fails on every attempt', () => {
	it('tells the client it failed', async () => {
		const chunks = await runFailingTurn(true);
		expect(chunks.at(-1)).toMatchObject({ type: 'error' });
	});

	it('records a terminal error event, not just a dangling "running" one', async () => {
		await runFailingTurn(true);
		const rows = turnEvents();
		// Previously only the opening `running` row was written and nothing closed
		// it, so the Observatory showed a turn that never ended and gave no reason.
		expect(rows.map((r) => r.status).sort()).toEqual(['error', 'running']);
		const failure = rows.find((r) => r.status === 'error')!;
		expect(String((failure.detail as Record<string, unknown>).reason)).toContain('ECONNREFUSED');
		expect(failure.chatId).toBe(CHAT_ID);
	});

	describe('in a hidden chat', () => {
		it('still records why it failed', async () => {
			await runFailingTurn(false);
			const failure = turnEvents().find((r) => r.status === 'error');
			expect(failure).toBeDefined();
			expect(String((failure!.detail as Record<string, unknown>).reason)).toContain('ECONNREFUSED');
		});

		it('records no chat id, in the event or in the usage row', async () => {
			await runFailingTurn(false);
			// The failure has to be diagnosable without making the conversation
			// identifiable — that is the whole bargain hidden mode strikes.
			for (const row of turnEvents()) expect(row.chatId).toBeNull();
			for (const row of db.select().from(usageLog).all()) expect(row.chatId).toBeNull();
			expect(JSON.stringify(turnEvents())).not.toContain(CHAT_ID);
		});

		it('leaves no opening "running" row behind either', async () => {
			await runFailingTurn(false);
			// Only the terminal failure is persisted for a hidden chat; the start
			// of the turn is streamed live and never stored.
			expect(turnEvents().map((r) => r.status)).toEqual(['error']);
		});
	});

	it('still counts the spend against the budget for a hidden chat', async () => {
		await runFailingTurn(false);
		const rows = db.select().from(usageLog).all();
		expect(rows).toHaveLength(1);
		expect(rows[0].status).toBe('error');
		expect(rows[0].userId).toBe('u1');
	});
});
