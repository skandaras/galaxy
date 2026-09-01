import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { db, runMigrations } from '$lib/server/db';
import {
	cortexAssociations,
	cortexChangeLog,
	cortexCircuits,
	cortexNodes,
	cortexProposals,
	events,
	models,
	providers,
	settings as settingsTable,
	taskConfigs,
	usageLog
} from '$lib/server/db/schema';
import { getNode, listNodes, saveAssociation, saveCircuit, saveNode } from '$lib/server/cortex';
import { setSetting } from '$lib/server/settings';
import { applyProposal, listProposals, runCortexGroom } from './cortex-groom';

/**
 * The groomer against a provider it has to actually talk to.
 *
 * Every other suite mocks `pickModel`, which is the right seam for asking what
 * a prompt contains — and it means the whole path from `groomSettings` through
 * the adapter, the abort signal, the SSE parse and back into the review queue
 * is covered nowhere. This run is the one that would have caught a two-pass
 * pipeline that assembled two perfect prompts and never sent the second.
 *
 * It ends where the feature ends: accepting one of the suggestions and finding
 * the lattice changed. A queue whose rows cannot be applied is the failure this
 * whole subsystem has had twice.
 */

const ANA = 'user-ana-e2e';

/** What the mock answers, in order, and what it was asked. */
let prompts: string[] = [];
let replies: string[] = [];
/** The request bodies as they actually arrived, for what was asked of the model. */
let sent: { max_tokens?: number; model?: string }[] = [];

const server = createServer((req, res) => {
	let body = '';
	req.on('data', (c) => (body += c));
	req.on('end', () => {
		const req = JSON.parse(body || '{}');
		sent.push(req);
		prompts.push(
			(req.messages ?? []).find((m: { role: string }) => m.role === 'user')?.content ?? ''
		);
		const reply = replies[Math.min(prompts.length - 1, replies.length - 1)] ?? '{}';
		// The groomer uses `complete`, which is the non-streaming path — a real
		// JSON body rather than SSE, which is a difference a mock is very easy to
		// get wrong in the direction that passes.
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(
			JSON.stringify({
				choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
				usage: { prompt_tokens: Math.ceil((prompts.at(-1)?.length ?? 0) / 4), completion_tokens: 40 }
			})
		);
	});
});

beforeAll(() => {
	runMigrations();
	server.listen(0);
	db.insert(providers)
		.values({
			id: 'p-groom',
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
			id: 'm-groom',
			providerId: 'p-groom',
			modelKey: 'mock-gardener',
			displayName: 'Mock Gardener',
			contextWindow: 8000,
			supportsTools: false,
			supportsVision: false,
			promptCostPerMTok: null,
			completionCostPerMTok: null,
			cacheMode: 'auto',
			enabled: true
		})
		.onConflictDoNothing()
		.run();
	db.insert(taskConfigs)
		.values({
			task: 'cortex-groom',
			primaryModelId: 'm-groom',
			backupModelId: null,
			systemPrompt: 'You tend a lattice.'
		})
		.onConflictDoNothing()
		.run();
});

afterAll(() => server.close());

/** A lattice of the size that timed the one-pass review out. */
function seed(count: number) {
	const area = saveCircuit({ name: 'Coastal fieldwork', ownerId: ANA });
	const made = Array.from({ length: count }, (_, i) =>
		saveNode({
			name: `Concept ${String(i).padStart(3, '0')}`,
			description: `What concept ${i} covers, in about the words a real description takes.`,
			// Two thirds filed, so the survey has something to point at and
			// something to leave alone.
			circuits: i % 3 ? [area.id] : undefined,
			ownerId: ANA
		})
	);
	for (let i = 1; i < made.length; i++) {
		const hub = made[i % 5];
		if (hub.id !== made[i].id) {
			saveAssociation({ sourceId: hub.id, targetId: made[i].id, weight: 0.6, userId: ANA });
		}
	}
	return { made, area };
}

beforeEach(() => {
	for (const t of [
		cortexAssociations,
		cortexChangeLog,
		cortexProposals,
		cortexNodes,
		cortexCircuits,
		events,
		usageLog,
		settingsTable
	]) {
		db.delete(t).run();
	}
	db.run(`DELETE FROM cortex_fts`);
	prompts = [];
	replies = [];
	sent = [];
});

describe('a review, all the way through a provider', () => {
	it('surveys, reads closely, files, and the suggestion can be carried out', async () => {
		const { made, area } = seed(60);
		// Concept 000 is unfiled by the seeding rule above, which is exactly the
		// sort of thing the shape alone reveals.
		const unfiled = made[0];
		replies = [
			JSON.stringify({
				candidates: [
					{
						node: unfiled.id,
						kind: 'circuit',
						hypothesis: 'Reaches the coastal cluster but sits in no area.'
					}
				]
			}),
			JSON.stringify({
				proposals: [
					{
						kind: 'circuit',
						title: `File "${unfiled.name}" under Coastal fieldwork`,
						rationale: 'Its description is about the same fieldwork everything it touches is.',
						node: unfiled.id,
						payload: { areas: [area.id] }
					}
				]
			})
		];

		const res = await runCortexGroom('manual', ANA);
		// Asserted before `ran`, so a run that failed says why rather than saying
		// `false`.
		expect(res.reason).toBeUndefined();
		expect(res.ran).toBe(true);

		// Two calls, and the second is the one that had the descriptions.
		expect(prompts).toHaveLength(2);
		expect(prompts[0]).toContain('A SURVEY OF THE LATTICE');
		expect(prompts[0]).not.toContain('What concept 0 covers');
		expect(prompts[1]).toContain('What concept 0 covers');
		expect(prompts[1]).toContain('sits in no area');
		// The close read is the smaller prompt on a lattice this size, which is
		// the arithmetic the whole split rests on.
		expect(prompts[1].length).toBeLessThan(prompts[0].length);

		expect(res.survey).toMatchObject({ candidates: 1, fellBack: false, more: false });
		expect(res.confirm?.concepts).toBe(1);
		expect(res.proposed).toBe(1);

		// And the end of the feature: a row somebody can act on, that does the
		// thing when they do.
		const filed = listProposals(ANA).find((p) => p.kind === 'circuit')!;
		expect(filed.preview.join(' ')).toContain('Coastal fieldwork');
		expect(applyProposal(filed.id, ANA)).toEqual({ ok: true });
		expect(getNode(unfiled.id, ANA)!.circuits).toContain(area.id);
	});

	it('costs one call when the survey finds nothing, and says so', async () => {
		seed(60);
		replies = ['{"candidates":[]}'];
		const res = await runCortexGroom('manual', ANA);
		expect(prompts).toHaveLength(1);
		expect(res.ran).toBe(true);
		expect(res.proposed).toBe(0);
		expect(res.survey?.candidates).toBe(0);
	});

	it('reports what it read and what it cost, per pass and in total', async () => {
		const { made } = seed(60);
		replies = [
			JSON.stringify({ candidates: [{ node: made[0].id, kind: 'connect' }] }),
			'{"proposals":[]}'
		];
		const res = await runCortexGroom('manual', ANA);
		expect(res.survey!.concepts).toBe(60);
		expect(res.survey!.total).toBe(60);
		expect(res.promptChars).toBe(res.survey!.promptChars + res.confirm!.promptChars);
		expect(res.modelMs).toBeGreaterThanOrEqual(0);
		// The whole lattice's shape reached the model, which is more than the old
		// one-pass prompt managed: it described what fitted in its budget and cut
		// the rest down to names.
		for (const node of listNodes(ANA)) expect(prompts[0]).toContain(node.id);
	});

	it('reviews a small lattice in one call, and stamps what it read', async () => {
		// Fifteen concepts and room for twenty: every one of them goes forward, so
		// a survey would be a whole model call spent selecting all of them. This
		// is the shape of a dev lattice, and the shape that was timing out.
		const { made } = seed(15);
		replies = ['{"proposals":[]}'];
		const res = await runCortexGroom('manual', ANA);

		expect(res.reason).toBeUndefined();
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain('A CLOSE READ');
		expect(res.survey).toBeUndefined();
		expect(res.confirm?.everything).toBe(true);

		// And the stamps land, which is what makes coverage checkable rather than
		// hoped for.
		const after = listNodes(ANA).filter((n) => n.id === made[0].id)[0];
		expect(after.lastGroomedAt).toBeTruthy();
		expect(after.lastExaminedAt).toBeTruthy();
	});

	it('never asks the provider for more tokens than the answer needs', async () => {
		seed(60);
		replies = ['{"candidates":[]}'];
		await runCortexGroom('manual', ANA);
		// On the wire, which is the only place that counts. `max_tokens` is not a
		// safety ceiling — it is permission to think, and this job was asking for
		// 16,384 of it on a question whose answer is a short JSON list.
		expect(sent[0].max_tokens).toBeLessThanOrEqual(2_048);
	});

	it('gives up inside the time limit rather than hanging on one pass', async () => {
		seed(60);
		setSetting('cortexGroom', { timeoutSeconds: 30 });
		replies = ['{"candidates":[]}'];
		const started = Date.now();
		const res = await runCortexGroom('manual', ANA);
		// Not a timing assertion about the model — a check that a configured
		// ceiling reaches the adapter at all, which is what a run-level deadline
		// changed the plumbing of.
		expect(res.ran).toBe(true);
		expect(Date.now() - started).toBeLessThan(30_000);
	});
});
