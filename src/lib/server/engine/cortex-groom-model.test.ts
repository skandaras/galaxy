import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, runMigrations } from '$lib/server/db';
import {
	cortexAssociations,
	cortexChangeLog,
	cortexNodes,
	cortexProposals,
	events,
	settings as settingsTable,
	usageLog
} from '$lib/server/db/schema';
import { listNodes, saveAssociation, saveNode } from '$lib/server/cortex';
import { getSetting } from '$lib/server/settings';

/**
 * The half of the groomer that talks to a model, which until now had no test at
 * all — every other suite covers a deterministic path, and this is the one that
 * parses whatever a model felt like returning.
 *
 * `pickModel` resolves the model inside the run, so the seam is a module mock
 * rather than an injected argument. The adapter is scripted per call, the same
 * shape `research.test.ts` uses.
 */

let scripted: string[] = [];
let calls: { system: string; user: string }[] = [];

vi.mock('./engine', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./engine')>();
	return {
		...actual,
		getTaskConfig: () => ({ task: 'cortex-groom', systemPrompt: 'you tend a lattice' }),
		pickModel: () => ({
			model: { modelKey: 'mock/model' },
			provider: {},
			adapter: {
				complete: async (req: { messages: { role: string; content: string }[] }) => {
					calls.push({
						system: req.messages.find((m) => m.role === 'system')?.content ?? '',
						user: req.messages.find((m) => m.role === 'user')?.content ?? ''
					});
					const reply = scripted[Math.min(calls.length - 1, scripted.length - 1)] ?? '[]';
					// A provider that fails outright, which is a different thing from
					// one that answers badly — and the case the watermark cares about.
					if (reply === '__throw__') throw new Error('provider exploded');
					return {
						text: reply,
						usage: { promptTokens: 100, completionTokens: 20 },
						finishReason: 'stop'
					};
				}
			}
		})
	};
});

const { runCortexGroom, listProposals } = await import('./cortex-groom');

const ANA = 'user-ana';

beforeAll(() => {
	runMigrations();
});

beforeEach(() => {
	db.delete(cortexAssociations).run();
	db.delete(cortexChangeLog).run();
	db.delete(cortexProposals).run();
	db.delete(cortexNodes).run();
	db.delete(events).run();
	db.delete(usageLog).run();
	// Watermarks live here, and a test that inherits one from the test before it
	// is a test that reports whatever the previous one left behind.
	db.delete(settingsTable).run();
	db.run(`DELETE FROM cortex_fts`);
	scripted = ['[]'];
	calls = [];

	const a = saveNode({ name: 'Tide pools', description: 'rockpool surveying', ownerId: ANA });
	const b = saveNode({ name: 'Coastal ecology', ownerId: ANA });
	saveNode({ name: 'Storm logs', ownerId: ANA });
	saveAssociation({ sourceId: a.id, targetId: b.id, userId: ANA });
});

describe('what a model returns', () => {
	it('files the concepts it proposes', async () => {
		scripted = [
			JSON.stringify({
				proposals: [
					{
						kind: 'create',
						title: 'Add "Salinity readings"',
						rationale: 'mentioned repeatedly',
						payload: { name: 'Salinity readings', connect: [{ node: 'tide-pools', weight: 0.7 }] }
					}
				]
			})
		];
		const res = await runCortexGroom('manual', ANA);
		expect(res.ran).toBe(true);
		expect(res.proposed).toBe(1);
		expect(listProposals(ANA).map((p) => p.kind)).toContain('create');
	});

	it('survives a model that returns prose instead of JSON', async () => {
		scripted = ['I had a look and honestly the lattice seems fine to me!'];
		const res = await runCortexGroom('manual', ANA);
		// Nothing filed, nothing thrown. A model that ignores the format is a
		// Tuesday, not an incident.
		expect(res.ran).toBe(true);
		expect(res.proposed).toBe(0);
	});

	it('survives a bare array, which is what a model naturally reaches for', async () => {
		// The shape the prompt used to ask for, and the one extractJson cannot
		// read. Getting nothing is correct; throwing would not be.
		scripted = ['[{"kind":"merge","title":"just the one"}]'];
		const res = await runCortexGroom('manual', ANA);
		expect(res.ran).toBe(true);
		expect(res.proposed).toBe(0);
	});

	it('survives an object with no proposals in it', async () => {
		scripted = ['{"notes":"nothing to suggest"}'];
		expect((await runCortexGroom('manual', ANA)).proposed).toBe(0);
	});

	it('drops a suggestion naming a concept that does not exist', async () => {
		scripted = [
			JSON.stringify({
				proposals: [
					{ kind: 'merge', title: 'Merge two things', node: 'tide-pools', target: 'invented-id' }
				]
			})
		];
		// A hallucinated id is the most likely bad output, and filing it would put
		// a suggestion in the queue that could never be accepted.
		expect((await runCortexGroom('manual', ANA)).proposed).toBe(0);
	});

	it('logs what the call cost against its own task', async () => {
		await runCortexGroom('manual', ANA);
		const row = db.select().from(usageLog).all().find((u) => u.task === 'cortex-groom');
		expect(row).toBeTruthy();
		expect(row!.promptTokens).toBe(100);
	});

	it('reports counts to the Observatory and no concept names', async () => {
		scripted = [
			JSON.stringify({
				proposals: [
					{ kind: 'create', title: 'Add a thing', payload: { name: 'A distinctive marker' } }
				]
			})
		];
		await runCortexGroom('manual', ANA);
		const serialised = JSON.stringify(db.select().from(events).all());
		expect(serialised).toContain('cortex.groom');
		expect(serialised).not.toContain('distinctive marker');
	});
});

describe('the watermark', () => {
	const mark = () => getSetting<number>('cortex.groom.watermark', 0, ANA);

	it('advances after a harvest that reached the model', async () => {
		expect(mark()).toBe(0);
		await runCortexGroom('schedule', ANA);
		expect(mark()).toBeGreaterThan(0);
	});

	it('does not advance when the call failed', async () => {
		scripted = ['__throw__'];
		// A failed pass that moved the watermark would swallow a day of
		// conversation, and look from the outside like a feature that simply
		// never picks anything up.
		const res = await runCortexGroom('schedule', ANA);
		expect(res.ran).toBe(false);
		expect(res.reason).toBe('model call failed');
		expect(mark()).toBe(0);
	});

	it('is left alone by a review, which never reads activity', async () => {
		await runCortexGroom('manual', ANA);
		expect(mark()).toBe(0);
	});
});

describe('what each mode sends', () => {
	it('a review sends the whole lattice with connections', async () => {
		await runCortexGroom('manual', ANA);
		expect(calls[0].user).toContain('A FULL REVIEW');
		expect(calls[0].user).toContain('connects to:');
	});

	it('a harvest sends the activity window and only a slice', async () => {
		await runCortexGroom('schedule', ANA);
		expect(calls[0].user).toContain('SINCE THE LAST PASS');
		expect(calls[0].user).toContain('names only');
	});

	it('carries the task’s own system prompt', async () => {
		await runCortexGroom('manual', ANA);
		expect(calls[0].system).toBe('you tend a lattice');
	});
});
