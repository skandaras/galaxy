import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, runMigrations } from '$lib/server/db';
import {
	chats,
	cortexAssociations,
	cortexChangeLog,
	cortexNodes,
	cortexProposals,
	events,
	memoryItems,
	messages,
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
					// A reasoning model that spent its whole budget thinking: text is
					// empty and reasonedOnly says why.
					if (reply === '__reasoned__') {
						return {
							text: '',
							usage: { promptTokens: 100, completionTokens: 20 },
							finishReason: 'length',
							reasonedOnly: true
						};
					}
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

/**
 * Something for a harvest to read. Needed by every harvest test now that a pass
 * with no conversation skips the model outright rather than asking it about
 * nothing.
 */
function haveTalked(text: string, when = new Date()) {
	const id = `chat-${when.getTime()}-${Math.random().toString(36).slice(2, 8)}`;
	db.insert(chats)
		.values({ id, userId: ANA, title: 'A conversation', mode: 'chat', createdAt: when, updatedAt: when })
		.run();
	db.insert(messages)
		.values({ id: `msg-${id}`, chatId: id, seq: 1, role: 'user', content: text, createdAt: when })
		.run();
}

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
	db.delete(messages).run();
	db.delete(chats).run();
	db.delete(memoryItems).run();
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
		haveTalked('something worth reading');
		expect(mark()).toBe(0);
		await runCortexGroom('schedule', ANA);
		expect(mark()).toBeGreaterThan(0);
	});

	it('does not advance when the call failed', async () => {
		haveTalked('something worth reading');
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
		haveTalked('something worth reading');
		await runCortexGroom('schedule', ANA);
		expect(calls[0].user).toContain('SINCE THE LAST PASS');
		expect(calls[0].user).toContain('names only');
	});

	it('carries the task’s own system prompt', async () => {
		await runCortexGroom('manual', ANA);
		expect(calls[0].system).toBe('you tend a lattice');
	});
});

/**
 * "Can you confirm the groomer is capable of finding anything in existing
 * conversations and memories?"
 *
 * A fair question after a live run read a real conversation and proposed
 * nothing. These cover the half that is testable here — that what was said
 * reaches the prompt. Whether a given model then judges it well is a question
 * only that model can answer, which is what the run's diagnostics are for.
 */
describe('what the harvest actually reads', () => {
	const SAID = 'quokkasunrise-conversation-marker';
	const REMEMBERED = 'narwhalthursday-memory-marker';

	function haveRecorded(content: string) {
		db.insert(memoryItems)
			.values({
				id: `mem-${content.slice(0, 8)}`,
				userId: ANA,
				kind: 'fact',
				content,
				status: 'active',
				createdAt: new Date()
			})
			.run();
	}

	it('puts what was said in front of the model', async () => {
		haveTalked(`I have been thinking about ${SAID} and how it connects to everything else.`);
		await runCortexGroom('schedule', ANA);
		expect(calls).toHaveLength(1);
		expect(calls[0].user).toContain(SAID);
	});

	it('puts recorded observations there too', async () => {
		haveTalked('something worth harvesting');
		haveRecorded(REMEMBERED);
		await runCortexGroom('schedule', ANA);
		expect(calls[0].user).toContain(REMEMBERED);
	});

	it('reports how much it read and how far back it looked', async () => {
		haveTalked(`a conversation about ${SAID}`);
		const res = await runCortexGroom('schedule', ANA);
		// The number that separates "found nothing to read" from "read plenty and
		// the model shrugged" — three outcomes that used to look identical.
		expect(res.activityChars).toBeGreaterThan(0);
		expect(res.windowHours).toBeGreaterThan(0);
	});

	it('does not call a model when there is nothing to read', async () => {
		const res = await runCortexGroom('schedule', ANA);
		expect(calls).toHaveLength(0);
		expect(res.ran).toBe(false);
		expect(res.reason).toBe('no new conversation in the window');
		expect(res.activityChars).toBe(0);
	});

	it('looks back three days on a first pass, not to the beginning of time', async () => {
		haveTalked(`old news about ${SAID}`, new Date(Date.now() - 10 * 86_400_000));
		const res = await runCortexGroom('schedule', ANA);
		// An unbounded first window is what timed the first live run out.
		expect(res.reason).toBe('no new conversation in the window');
		expect(res.windowHours).toBeLessThanOrEqual(73);
	});

	it('keeps the conversation out of the Observatory', async () => {
		haveTalked(`I have been thinking about ${SAID}.`);
		await runCortexGroom('schedule', ANA);
		// Sizes and flags reach an event detail; what was said never does.
		expect(JSON.stringify(db.select().from(events).all())).not.toContain(SAID);
	});
});

describe('a model that thinks instead of answering', () => {
	it('says so, rather than looking like silence', async () => {
		haveTalked('a rich conversation worth harvesting');
		scripted = ['__reasoned__'];
		const res = await runCortexGroom('schedule', ANA);
		// The failure research.ts already names, which this job used to report as
		// an ordinary empty answer.
		expect(res.reasonedOnly).toBe(true);
		expect(res.replyChars).toBe(0);
	});
});
