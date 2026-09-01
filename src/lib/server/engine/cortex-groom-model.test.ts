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
let calls: { system: string; user: string; maxTokens: number }[] = [];
/**
 * How long each call was given, in the order they were made.
 *
 * A real `AbortSignal` does not say what it was built with, so the split of the
 * run's deadline across two passes is only assertable from here. Spied rather
 * than timed: a wall-clock assertion passes whatever the split is, which is the
 * same trap the prompt-cost test already names.
 */
let allowed: number[] = [];

/** What a survey says when it wants these concepts read closely. */
function pointsAt(...ids: string[]) {
	return JSON.stringify({
		candidates: ids.map((id) => ({ node: id, kind: 'circuit', hypothesis: 'looks unfiled' }))
	});
}

vi.mock('./engine', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./engine')>();
	return {
		...actual,
		getTaskConfig: () => ({ task: 'cortex-groom', systemPrompt: 'you tend a lattice' }),
		pickModel: () => ({
			model: { modelKey: 'mock/model' },
			provider: {},
			adapter: {
				complete: async (req: {
					messages: { role: string; content: string }[];
					maxTokens: number;
				}) => {
					calls.push({
						system: req.messages.find((m) => m.role === 'system')?.content ?? '',
						user: req.messages.find((m) => m.role === 'user')?.content ?? '',
						// Recorded so the retry can be asserted on what it actually asked
						// for, rather than on the fact that a second call happened.
						maxTokens: req.maxTokens
					});
					const reply = scripted[Math.min(calls.length - 1, scripted.length - 1)] ?? '[]';
					// A provider that fails outright, which is a different thing from
					// one that answers badly — and the case the watermark cares about.
					if (reply === '__throw__') throw new Error('provider exploded');
						// A call that ran out of time, which has to be named as one.
						if (reply === '__throw_timeout__') {
							throw new Error('The operation was aborted due to timeout');
						}
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
	allowed = [];
	// The signal spy below wraps whatever is currently there, so without this the
	// wrappers stack across tests and every call gets recorded twice.
	vi.restoreAllMocks();
	// Records what each call was allowed, and still returns a real signal so the
	// production path is unchanged.
	const timeout = AbortSignal.timeout.bind(AbortSignal);
	vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
		allowed.push(ms);
		return timeout(ms);
	});

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
		// The provider's own words. Every failure used to come back as "model
		// call failed", so the one thing worth knowing — which wall was hit —
		// existed only in the Observatory and had to be dug out by hand.
		expect(res.reason).toBe('provider exploded');
		expect(mark()).toBe(0);
	});

	it('is left alone by a review, which never reads activity', async () => {
		await runCortexGroom('manual', ANA);
		expect(mark()).toBe(0);
	});
});

describe('what each mode sends', () => {
	it('a review sends the lattice’s shape first, and no descriptions with it', async () => {
		scripted = [pointsAt('tide-pools'), '{"proposals":[]}'];
		await runCortexGroom('manual', ANA);
		expect(calls[0].user).toContain('A SURVEY OF THE LATTICE');
		expect(calls[0].user).toContain('coastal-ecology');
		// The whole reason the wide pass is affordable.
		expect(calls[0].user).not.toContain('rockpool surveying');
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
 * The failure this split exists for: a review of a 52-concept lattice timed out
 * at 180 seconds. The prompt was around 25KB — well inside any model's window —
 * so the cost was never the bytes. It was asking one model, in one shot, to hold
 * every concept's name, description and connections in mind *and* produce ten
 * justified structural changes.
 *
 * Two easy questions instead of one hard one: a wide shallow pass over shape,
 * then a narrow deep pass over the handful it points at.
 */
describe('a review, in two passes', () => {
	/** Enough concepts that sending them all in full is the thing being avoided. */
	function wide(count: number, pad = '') {
		return Array.from({ length: count }, (_, i) =>
			saveNode({
				name: `Concept ${String(i).padStart(3, '0')}${pad}`,
				description: `The description of concept ${i}, about as long as a real one is.`,
				ownerId: ANA
			})
		);
	}

	it('surveys the shape, then reads closely only what that turned up', async () => {
		const made = wide(50);
		scripted = [pointsAt(made[7].id), '{"proposals":[]}'];
		const res = await runCortexGroom('manual', ANA);

		expect(calls).toHaveLength(2);
		expect(res.survey?.candidates).toBe(1);
		// The close read sees the one description the survey asked for, and not
		// the forty-nine it did not.
		expect(calls[1].user).toContain('The description of concept 7,');
		expect(calls[1].user).not.toContain('The description of concept 30,');
		expect(calls[1].user).toContain('looks unfiled');
		// And it is a fraction of the pass it replaces. The old review sent every
		// description it could afford; this sends one.
		expect(calls[1].user.length).toBeLessThan(calls[0].user.length);
	});

	it('believes a survey that says there is nothing worth reading', async () => {
		wide(50);
		scripted = ['{"candidates":[]}'];
		const res = await runCortexGroom('manual', ANA);
		// An empty list is an answer, and finding nothing is the commonest outcome
		// the groomer has. Paying for a close read of nothing would double the
		// cost of the ordinary case.
		expect(calls).toHaveLength(1);
		expect(res.ran).toBe(true);
		expect(res.proposed).toBe(0);
		expect(res.survey?.candidates).toBe(0);
		expect(res.survey?.fellBack).toBe(false);
		expect(res.confirm).toBeUndefined();
	});

	it('reads closely anyway when the survey answers with prose', async () => {
		const made = wide(50);
		scripted = [
			'Honestly the shape of this lattice looks fine to me.',
			JSON.stringify({
				proposals: [
					{ kind: 'rename', title: 'Rename it', node: made[0].id, payload: { name: 'Renamed' } }
				]
			})
		];
		const res = await runCortexGroom('manual', ANA);
		// A wide pass that does not answer should not cost the whole run: the deep
		// read is affordable by construction, and there is a defensible shortlist
		// to be had without a model.
		expect(calls).toHaveLength(2);
		expect(res.survey?.fellBack).toBe(true);
		expect(res.proposed).toBe(1);
		// And it says so rather than passing the shortlist off as the survey's.
		expect(calls[1].user).toContain('THE SURVEY DID NOT ANSWER');
	});

	it('drops an invented id rather than reading closely about nothing', async () => {
		wide(50);
		scripted = ['{"candidates":[{"node":"never-existed"}]}', '{"proposals":[]}'];
		const res = await runCortexGroom('manual', ANA);
		expect(res.survey?.dropped).toBe(1);
		// Every candidate invented is a survey that did not answer, whatever it
		// looked like — so the close read still happens, on a shortlist that
		// exists.
		expect(res.survey?.fellBack).toBe(true);
		expect(calls).toHaveLength(2);
	});

	it('splits one deadline across the two passes rather than doubling it', async () => {
		wide(50);
		scripted = [pointsAt('concept-007'), '{"proposals":[]}'];
		await runCortexGroom('manual', ANA);
		const whole = 300_000;
		// A manual run is one synchronous request, so the number in the box is the
		// number somebody set their reverse proxy against. Two calls each given
		// the full limit would quietly mean twice it: what each call is allowed is
		// what is *left* of the run, never the setting again.
		expect(allowed.every((ms) => ms <= whole)).toBe(true);
		// The survey may have half at most, so a slow wide pass cannot leave the
		// close read with nothing...
		expect(allowed[0]).toBeLessThanOrEqual(whole / 2);
		// ...and hands its slack forward rather than keeping it: this survey came
		// back at once, so the close read gets nearly the whole run.
		expect(allowed[1]).toBeGreaterThan(whole / 2);
	});

	it('says how much of the lattice it looked at', async () => {
		wide(50);
		scripted = [pointsAt('concept-007'), '{"proposals":[]}'];
		const res = await runCortexGroom('manual', ANA);
		expect(res.survey?.total).toBe(53);
		expect(res.survey?.concepts).toBe(53);
		expect(res.survey?.more).toBe(false);
		expect(res.confirm?.concepts).toBe(1);
	});

	it('carries a lattice too wide for one survey over to the next run', async () => {
		// Long names rather than a thousand concepts: the budget is on characters,
		// and this makes the same point in a fiftieth of the inserts.
		wide(250, ` — ${'padding '.repeat(40)}`);
		scripted = ['{"candidates":[]}'];

		const first = await runCortexGroom('manual', ANA);
		expect(first.survey?.more).toBe(true);
		expect(first.survey!.concepts).toBeLessThan(first.survey!.total);
		const seenFirst = calls[0].user;

		calls = [];
		const second = await runCortexGroom('manual', ANA);
		// The old ceiling simply dropped the tail, so on a large lattice there
		// were concepts no review ever looked at. This one moves on.
		expect(second.survey?.concepts).toBeGreaterThan(0);
		expect(calls[0].user).not.toBe(seenFirst);
	});

	it('a harvest stays one call', async () => {
		haveTalked('a conversation worth harvesting');
		scripted = ['{"proposals":[]}'];
		await runCortexGroom('schedule', ANA);
		// The split is a review's answer to a review's problem. A harvest's prompt
		// is small by construction and its failure was output tokens, which the
		// retry already answers.
		expect(calls).toHaveLength(1);
	});

	it('names the pass that ran out, not just that something did', async () => {
		wide(50);
		scripted = ['__throw_timeout__'];
		const res = await runCortexGroom('manual', ANA);
		expect(res.ran).toBe(false);
		// "The model did not answer" was already the least useful sentence in the
		// system when there was one call to blame.
		expect(res.reason).toContain('survey');
	});

	it('reports what each pass cost, and the run’s total', async () => {
		wide(50);
		scripted = [pointsAt('concept-007'), '{"proposals":[]}'];
		const res = await runCortexGroom('manual', ANA);
		expect(res.survey!.promptChars).toBeGreaterThan(0);
		expect(res.confirm!.promptChars).toBeGreaterThan(0);
		// The panel has always shown one line for this. Keeping the top-level
		// numbers as the sum is what lets that line stay true now there are two.
		expect(res.promptChars).toBe(res.survey!.promptChars + res.confirm!.promptChars);
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
	/**
	 * The failure that actually stopped this job on a real lattice: a reasoning
	 * model spent its whole 8,192-token budget on chain-of-thought and never
	 * began an answer, on 4,860 characters of conversation. The run detected it,
	 * reported it, and stopped — and told the person to raise a Max tokens field
	 * that does not exist anywhere in the app.
	 */
	it('asks again with real headroom, and gets an answer', async () => {
		haveTalked('a rich conversation worth harvesting');
		// Thinks itself out of room, then answers when given space.
		scripted = ['__reasoned__', '{"proposals":[{"kind":"create","title":"Tide pools"}]}'];
		const res = await runCortexGroom('schedule', ANA);

		expect(res.ran).toBe(true);
		expect(res.retried).toBe(true);
		expect(res.proposed).toBe(1);
		expect(calls).toHaveLength(2);
		// Headroom, not a nudge. A second attempt at the same budget would fail
		// the same way and cost a second call to find that out.
		expect(calls[1].maxTokens).toBeGreaterThan(calls[0].maxTokens * 2);
		// And the same prompt both times: it is the budget that was wrong, not
		// what was asked, and rebuilding it would be work for nothing.
		expect(calls[1].user).toBe(calls[0].user);
	});

	it('does not retry a model that simply had nothing to suggest', async () => {
		haveTalked('a quiet conversation');
		scripted = ['{"proposals":[]}'];
		const res = await runCortexGroom('schedule', ANA);
		// An empty list is an answer. Retrying it would double the cost of the
		// commonest outcome the groomer has — most passes find nothing.
		expect(res.ran).toBe(true);
		expect(res.retried).toBe(false);
		expect(calls).toHaveLength(1);
	});

	it('says so when even the headroom is not enough', async () => {
		haveTalked('a rich conversation worth harvesting');
		scripted = ['__reasoned__'];
		const res = await runCortexGroom('schedule', ANA);
		expect(res.reasonedOnly).toBe(true);
		expect(res.replyChars).toBe(0);
		// Having tried is the thing worth reporting: it tells the person that
		// raising the budget is the second thing to try, not the first.
		expect(res.retried).toBe(true);
		expect(calls).toHaveLength(2);
	});

	it('reports what the run cost, so "it grinds" is a number', async () => {
		haveTalked('a rich conversation worth harvesting');
		scripted = ['{"proposals":[]}'];
		const res = await runCortexGroom('schedule', ANA);
		// Answering "where did the time go" the first time meant reading the
		// source to work out where it could possibly have gone.
		expect(res.promptChars).toBeGreaterThan(0);
		expect(res.buildMs).toBeGreaterThanOrEqual(0);
		expect(res.modelMs).toBeGreaterThanOrEqual(0);
	});
});
