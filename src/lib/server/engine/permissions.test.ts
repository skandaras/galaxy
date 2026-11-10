import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, runMigrations } from '$lib/server/db';
import { mcpServers, mcpTools, notifications, settings } from '$lib/server/db/schema';
import { createJob, subscribeJob, type JobChunk, type LiveJob } from './jobs';
import { openPromptCount } from './park';
import {
	answerPermission,
	listGrants,
	requestPermission,
	revokeGrant,
	type ToolPermission
} from './permissions';

beforeAll(() => {
	runMigrations();
	// Grants are pruned against the catalogue, so the tools used below have to exist.
	db.insert(mcpServers)
		.values({
			id: 'srv',
			name: 'Files',
			transport: 'http',
			url: 'http://localhost/mcp',
			toolPrefix: 'files',
			createdAt: new Date()
		})
		.run();
	for (const name of ['read', 'write']) {
		db.insert(mcpTools)
			.values({ id: `srv:${name}`, serverId: 'srv', name: `files__${name}`, remoteName: name })
			.run();
	}
});

const read: ToolPermission = { key: 'srv:read', label: 'files__read', server: 'Files' };
const write: ToolPermission = { key: 'srv:write', label: 'files__write', server: 'Files' };

const opened: LiveJob[] = [];

afterEach(() => {
	// Aborting settles whatever a test left waiting, so the next one starts clean.
	for (const job of opened.splice(0)) job.controller.abort();
	expect(openPromptCount()).toBe(0);
});

let n = 0;
function harness(opts: { userId?: string; chatId?: string; persist?: boolean } = {}) {
	const userId = opts.userId ?? `u${++n}`;
	const chatId = opts.chatId ?? `chat-${++n}`;
	const persist = opts.persist ?? true;
	const job = createJob({ chatId, userId, task: 'chat', persist });
	const chunks: JobChunk[] = [];
	subscribeJob(job, (c) => chunks.push(c));
	opened.push(job);
	const ask = (permission = read, over: { job?: LiveJob; chatId?: string } = {}) =>
		requestPermission({
			job: over.job ?? job,
			userId,
			chatId: over.chatId ?? chatId,
			persist,
			permission,
			summary: 'path=/tmp/x'
		});
	return { job, chunks, userId, chatId, ask };
}

const requestIn = (chunks: JobChunk[]) =>
	chunks.find((c) => c.type === 'permission') as Extract<JobChunk, { type: 'permission' }>;
const closedIn = (chunks: JobChunk[]) =>
	chunks.find((c) => c.type === 'permission_done') as Extract<JobChunk, { type: 'permission_done' }>;
const askedCount = (chunks: JobChunk[]) => chunks.filter((c) => c.type === 'permission').length;

describe('the four decisions', () => {
	it('puts the request on the stream and waits', async () => {
		const { chunks, ask, userId } = harness();
		const pending = ask();
		const req = requestIn(chunks);
		expect(req).toMatchObject({ tool: 'files__read', server: 'Files', summary: 'path=/tmp/x' });
		expect(openPromptCount('permission')).toBe(1);

		expect(answerPermission(req.id, userId, 'once')).toBe(true);
		await expect(pending).resolves.toBe('allow');
		expect(closedIn(chunks)).toEqual({ type: 'permission_done', id: req.id, decision: 'once' });
	});

	it('once allows this call and asks again next time', async () => {
		const { chunks, ask, userId } = harness();
		const first = ask();
		answerPermission(requestIn(chunks).id, userId, 'once');
		await first;

		void ask();
		expect(askedCount(chunks)).toBe(2);
	});

	it('deny refuses the call and remembers nothing', async () => {
		const { chunks, ask, userId } = harness();
		const first = ask();
		answerPermission(requestIn(chunks).id, userId, 'deny');
		await expect(first).resolves.toBe('deny');
		expect(closedIn(chunks).decision).toBe('deny');

		void ask();
		expect(askedCount(chunks)).toBe(2);
	});

	it('session allows the next call in the same chat without asking', async () => {
		const { chunks, ask, userId } = harness();
		const first = ask();
		answerPermission(requestIn(chunks).id, userId, 'session');
		await first;

		await expect(ask()).resolves.toBe('allow');
		expect(askedCount(chunks)).toBe(1);
	});

	it('session does not carry into another chat', async () => {
		const a = harness({ userId: 'same-user', chatId: 'chat-a' });
		const first = a.ask();
		answerPermission(requestIn(a.chunks).id, 'same-user', 'session');
		await first;

		const b = harness({ userId: 'same-user', chatId: 'chat-b' });
		void b.ask();
		expect(askedCount(b.chunks)).toBe(1);
	});

	it('always allows the tool in every chat', async () => {
		const a = harness({ userId: 'always-user', chatId: 'chat-a1' });
		const first = a.ask();
		answerPermission(requestIn(a.chunks).id, 'always-user', 'always');
		await first;

		const b = harness({ userId: 'always-user', chatId: 'chat-b1' });
		await expect(b.ask()).resolves.toBe('allow');
		expect(askedCount(b.chunks)).toBe(0);
		expect(listGrants('always-user')).toMatchObject([
			{ key: 'srv:read', label: 'files__read', server: 'Files' }
		]);
	});

	it('a grant covers the tool it was given for and no other', async () => {
		const { chunks, ask, userId } = harness();
		const first = ask(read);
		answerPermission(requestIn(chunks).id, userId, 'always');
		await first;

		// The second request is write's own; read's grant did not cover it.
		void ask(write);
		expect(askedCount(chunks)).toBe(2);
	});
});

describe('revoking', () => {
	it('brings the prompt back', async () => {
		const a = harness({ userId: 'revoker' });
		const first = a.ask();
		answerPermission(requestIn(a.chunks).id, 'revoker', 'always');
		await first;

		expect(revokeGrant('revoker', 'srv:read')).toBe(true);
		expect(revokeGrant('revoker', 'srv:read')).toBe(false);
		expect(listGrants('revoker')).toEqual([]);

		const b = harness({ userId: 'revoker' });
		void b.ask();
		expect(askedCount(b.chunks)).toBe(1);
	});

	it('leaves other people alone', async () => {
		const a = harness({ userId: 'owner-of-grant' });
		const first = a.ask();
		answerPermission(requestIn(a.chunks).id, 'owner-of-grant', 'always');
		await first;

		expect(revokeGrant('someone-else', 'srv:read')).toBe(false);
		expect(listGrants('owner-of-grant')).toHaveLength(1);
	});

	it('drops and removes a grant whose tool no longer exists', async () => {
		const ghost: ToolPermission = { key: 'gone:tool', label: 'gone__tool' };
		const a = harness({ userId: 'pruner' });
		const first = a.ask(ghost);
		answerPermission(requestIn(a.chunks).id, 'pruner', 'always');
		await first;

		expect(listGrants('pruner')).toEqual([]);
		expect(db.select().from(settings).where(eq(settings.scope, 'pruner')).all()).toHaveLength(0);
	});
});

describe('stopping and answering', () => {
	it('resolves to deny when the run is stopped', async () => {
		const { job, chunks, ask } = harness();
		const pending = ask();
		job.controller.abort();
		await expect(pending).resolves.toBe('deny');
		expect(closedIn(chunks).decision).toBe('deny');
		expect(openPromptCount()).toBe(0);
	});

	it('does not ask a run that is already stopped', async () => {
		const { job, chunks, ask } = harness();
		job.controller.abort();
		await expect(ask()).resolves.toBe('deny');
		expect(askedCount(chunks)).toBe(0);
	});

	it('refuses an answer from another user', async () => {
		const { chunks, ask, userId } = harness({ userId: 'alice' });
		const pending = ask();
		const req = requestIn(chunks);

		expect(answerPermission(req.id, 'bob', 'always')).toBe(false);
		expect(openPromptCount('permission')).toBe(1);
		expect(answerPermission(req.id, userId, 'once')).toBe(true);
		await pending;
	});

	it('refuses a decision outside the four, leaving the request open', async () => {
		const { chunks, ask, userId } = harness();
		const pending = ask();
		const req = requestIn(chunks);

		for (const bad of ['allow', 'ALWAYS', '', 'always ', null, 1, undefined, { a: 1 }]) {
			expect(answerPermission(req.id, userId, bad)).toBe(false);
		}
		expect(openPromptCount('permission')).toBe(1);
		answerPermission(req.id, userId, 'deny');
		await expect(pending).resolves.toBe('deny');
	});

	it('reports an unknown or already-settled request as false', async () => {
		const { chunks, ask, userId } = harness();
		const pending = ask();
		const req = requestIn(chunks);
		expect(answerPermission(req.id, userId, 'once')).toBe(true);
		await pending;
		expect(answerPermission(req.id, userId, 'once')).toBe(false);
		expect(answerPermission('never-asked', userId, 'once')).toBe(false);
	});

	it('marks the job parked while waiting and clears it after', async () => {
		const { job, chunks, ask, userId } = harness();
		const pending = ask();
		expect(job.parked).toBe(1);
		answerPermission(requestIn(chunks).id, userId, 'once');
		await pending;
		expect(job.parked).toBe(0);
	});
});

describe('a worker prompting on its parent', () => {
	it('lands the chunks on the job that was passed, not the caller', async () => {
		const parent = harness({ userId: 'nested-user' });
		const child = harness({ userId: 'nested-user' });
		const pending = child.ask(read, { job: parent.job, chatId: parent.chatId });

		expect(requestIn(parent.chunks)).toBeTruthy();
		expect(requestIn(child.chunks)).toBeUndefined();
		answerPermission(requestIn(parent.chunks).id, 'nested-user', 'once');
		await pending;
		expect(closedIn(parent.chunks)).toBeTruthy();
		expect(closedIn(child.chunks)).toBeUndefined();
	});
});

describe('a hidden chat', () => {
	it('keeps its session grant off the database', async () => {
		const { chunks, ask, userId, chatId } = harness({ persist: false });
		const first = ask();
		answerPermission(requestIn(chunks).id, userId, 'session');
		await first;

		// The grant still works for the rest of the chat...
		await expect(ask()).resolves.toBe('allow');
		// ...and nothing anywhere stores the chat's id.
		expect(db.select().from(settings).where(eq(settings.scope, chatId)).all()).toHaveLength(0);
	});

	it('writes no notifications row, though a persisted chat does', async () => {
		const hidden = harness({ userId: 'hush', persist: false });
		void hidden.ask();
		expect(db.select().from(notifications).where(eq(notifications.userId, 'hush')).all()).toHaveLength(0);

		const kept = harness({ userId: 'loud', chatId: 'kept-chat-id' });
		void kept.ask();
		const rows = db.select().from(notifications).where(eq(notifications.userId, 'loud')).all();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ kind: 'permission', urgent: true });
	});
});
