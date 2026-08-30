import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, runMigrations } from '$lib/server/db';
import { cortexAssociations, cortexNodes, settings as settingsTable } from '$lib/server/db/schema';
import {
	activate,
	decayReinforcement,
	effectiveWeight,
	erodedEdges,
	listAssociations,
	saveAssociation,
	saveNode,
	visibleEdges,
	MIN_EFFECTIVE_WEIGHT,
	REINFORCE_CEILING
} from '$lib/server/cortex';
import { setSetting } from '$lib/server/settings';
import { learnFromReply, learningInternals, rememberActivation } from './cortex-learn';

/**
 * The Hebbian half.
 *
 * Two claims are worth holding down here, because both are easy to break
 * accidentally and neither shows up as an error: that a reply strengthens only
 * the connections it actually leaned on, and that erosion stops at a floor
 * rather than deleting anything.
 */

const ANA = 'user-ana';
const BEN = 'user-ben';
const CHAT = 'chat-1';

beforeAll(() => {
	runMigrations();
});

beforeEach(() => {
	db.delete(cortexAssociations).run();
	db.delete(cortexNodes).run();
	db.delete(settingsTable).run();
	db.run(`DELETE FROM cortex_fts`);
	learningInternals.clear();
});

/** Three concepts in a line: a seed, its neighbour, and one further out. */
function chain() {
	const tide = saveNode({
		name: 'Tide pools',
		description: 'Rockpool surveying at low water',
		ownerId: ANA
	});
	const ecology = saveNode({
		name: 'Coastal ecology',
		description: 'How a shoreline works as a system',
		ownerId: ANA
	});
	const funding = saveNode({
		name: 'Grant writing',
		description: 'Making a case for money',
		ownerId: ANA
	});
	saveAssociation({ sourceId: tide.id, targetId: ecology.id, weight: 0.8, userId: ANA });
	saveAssociation({ sourceId: tide.id, targetId: funding.id, weight: 0.8, userId: ANA });
	return { tide, ecology, funding };
}

const edge = (a: string, b: string) =>
	visibleEdges(ANA).find(
		(e) =>
			(e.sourceId === a && e.targetId === b) || (e.sourceId === b && e.targetId === a)
	)!;

describe('what counts as using a connection', () => {
	it('strengthens the path to a concept the reply named, and leaves the rest alone', () => {
		const { tide, ecology, funding } = chain();
		const result = activate({ userId: ANA, query: 'tide pools rockpool surveying' });
		expect(result.nodes.map((n) => n.node.id)).toContain(ecology.id);
		rememberActivation(CHAT, ANA, result);

		const learned = learnFromReply(
			CHAT,
			'Given how you think about Coastal ecology, the low-water window is the constraint.'
		);
		expect(learned.used).toBe(1);
		expect(learned.edges).toBe(1);

		// The connection the answer travelled down gained; the one to the concept
		// it ignored did not. Reinforcing both would be reinforcing on retrieval,
		// which is the lattice grading its own homework.
		expect(edge(tide.id, ecology.id).reinforcement).toBeGreaterThan(0);
		expect(edge(tide.id, funding.id).reinforcement).toBe(0);
	});

	it('strengthens nothing when the reply used none of what came back', () => {
		const { tide, ecology } = chain();
		rememberActivation(CHAT, ANA, activate({ userId: ANA, query: 'tide pools' }));

		const learned = learnFromReply(CHAT, 'Sorry, I have nothing useful on that.');
		expect(learned.used).toBe(0);
		expect(learned.edges).toBe(0);
		expect(edge(tide.id, ecology.id).reinforcement).toBe(0);
	});

	it('judges a turn once, then forgets it', () => {
		const { tide, ecology } = chain();
		rememberActivation(CHAT, ANA, activate({ userId: ANA, query: 'tide pools' }));
		learnFromReply(CHAT, 'Coastal ecology, then.');
		const after = edge(tide.id, ecology.id).reinforcement;

		// A second reply in the same conversation must not re-bank the first one's
		// concepts: the agent would have had to ask again to have used them again.
		expect(learnFromReply(CHAT, 'Coastal ecology, again.').edges).toBe(0);
		expect(edge(tide.id, ecology.id).reinforcement).toBe(after);
	});

	it('never strengthens past the ceiling', () => {
		const { tide, ecology } = chain();
		for (let i = 0; i < 40; i++) {
			rememberActivation(CHAT, ANA, activate({ userId: ANA, query: 'tide pools' }));
			learnFromReply(CHAT, 'Coastal ecology matters here.');
		}
		// Unbounded strengthening is how a lattice walks itself toward a fully
		// connected mesh, where activation spreads everywhere and therefore
		// nowhere.
		expect(edge(tide.id, ecology.id).reinforcement).toBeLessThanOrEqual(REINFORCE_CEILING);
		expect(effectiveWeight(edge(tide.id, ecology.id))).toBeLessThanOrEqual(1);
	});

	it('will not move a weight in a lattice the learner cannot see', () => {
		const a = saveNode({ name: 'Ben one', ownerId: BEN });
		const b = saveNode({ name: 'Ben two', ownerId: BEN });
		saveAssociation({ sourceId: a.id, targetId: b.id, weight: 0.5, userId: BEN });
		chain();

		// Hand Ana an episode naming Ben's edge — a thing only a bug could
		// produce, which is exactly why the write path checks rather than trusts.
		rememberActivation(CHAT, ANA, {
			seeds: [a.id],
			nodes: [{ node: a, activation: 1, hops: 0 }],
			traversed: [{ sourceId: a.id, targetId: b.id }],
			pathTo: new Map([[a.id, [{ sourceId: a.id, targetId: b.id }]]])
		});
		expect(learnFromReply(CHAT, 'About Ben one.').edges).toBe(0);
		const bens = db
			.select()
			.from(cortexAssociations)
			.where(eq(cortexAssociations.sourceId, a.id))
			.get()!;
		expect(bens.reinforcement).toBe(0);
	});

	it('ignores a name too short to mean anything', () => {
		// "AI" would fire on almost any reply, and the shorter the name the more
		// confidently it does so for the wrong reason.
		expect(learningInternals.mentions('An AI wrote this', 'AI')).toBe(false);
		expect(learningInternals.mentions('About tide pools today', 'Tide pools')).toBe(true);
		// Whole words: a concept called "press" must not fire on "impressive".
		expect(learningInternals.mentions('That was impressive', 'press')).toBe(false);
		expect(learningInternals.mentions('the press, mostly', 'press')).toBe(true);
	});
});

describe('traversal is counted, not rewarded', () => {
	it('records that activation crossed an edge without moving its weight', () => {
		const { tide, ecology } = chain();
		activate({ userId: ANA, query: 'tide pools rockpool surveying' });
		const crossed = edge(tide.id, ecology.id);
		expect(crossed.traversalCount).toBeGreaterThan(0);
		expect(crossed.lastTraversedAt).toBeTruthy();
		// The whole distinction: walked is not the same as useful.
		expect(crossed.reinforcement).toBe(0);
	});
});

describe('erosion', () => {
	const day = 86_400_000;

	it('fades what nothing uses, and stops at the floor', () => {
		const { tide, ecology } = chain();
		setSetting('cortex.learn.lastDecay', Date.now() - 30 * day);
		decayReinforcement();
		expect(effectiveWeight(edge(tide.id, ecology.id))).toBeLessThan(0.8);

		// Years of it, and the connection is still there and still readable — it
		// has simply stopped crowding results. Removing it is a suggestion, never
		// something decay does on its own.
		setSetting('cortex.learn.lastDecay', Date.now() - 2000 * day);
		decayReinforcement();
		expect(effectiveWeight(edge(tide.id, ecology.id))).toBe(MIN_EFFECTIVE_WEIGHT);
		expect(listAssociations(tide.id, ANA).length).toBe(2);
		expect(ecology).toBeTruthy();
	});

	it('erodes two differently-authored connections to the same place', () => {
		const a = saveNode({ name: 'Alpha', ownerId: ANA });
		const b = saveNode({ name: 'Beta', ownerId: ANA });
		const c = saveNode({ name: 'Gamma', ownerId: ANA });
		saveAssociation({ sourceId: a.id, targetId: b.id, weight: 0.95, userId: ANA });
		saveAssociation({ sourceId: a.id, targetId: c.id, weight: 0.2, userId: ANA });
		setSetting('cortex.learn.lastDecay', Date.now() - 3000 * day);
		decayReinforcement();
		// The point of eroding the sum rather than the learned half: where an edge
		// ends up should depend on whether it gets used, not on how confident
		// whoever created it happened to feel.
		for (const e of visibleEdges(ANA)) expect(effectiveWeight(e)).toBe(MIN_EFFECTIVE_WEIGHT);
	});

	it('decays by elapsed time, so an outage is not a holiday', () => {
		chain();
		const start = Date.now();
		// Ten days in one go.
		setSetting('cortex.learn.lastDecay', start - 10 * day);
		decayReinforcement(start);
		const inOneGo = visibleEdges(ANA)[0].reinforcement;

		db.update(cortexAssociations).set({ reinforcement: 0 }).run();
		// The same ten days, a day at a time.
		for (let i = 10; i > 0; i--) {
			setSetting('cortex.learn.lastDecay', start - i * day);
			decayReinforcement(start - (i - 1) * day);
		}
		expect(visibleEdges(ANA)[0].reinforcement).toBeCloseTo(inOneGo, 5);
	});

	it('leaves everything alone when learning is switched off', () => {
		chain();
		setSetting('cortex', { learning: false });
		setSetting('cortex.learn.lastDecay', Date.now() - 100 * day);
		expect(decayReinforcement().edges).toBe(0);
		expect(visibleEdges(ANA).every((e) => e.reinforcement === 0)).toBe(true);
	});

	it('only calls an edge eroded once it is at the floor and long untouched', () => {
		const { tide, ecology } = chain();
		const now = Date.now();
		expect(erodedEdges(ANA, 60, now)).toHaveLength(0);

		setSetting('cortex.learn.lastDecay', now - 3000 * day);
		decayReinforcement(now);
		// At the floor, but traversed this minute: still doing its job quietly.
		db.update(cortexAssociations).set({ lastTraversedAt: new Date(now) }).run();
		expect(erodedEdges(ANA, 60, now)).toHaveLength(0);

		db.update(cortexAssociations)
			.set({ lastTraversedAt: new Date(now - 90 * day) })
			.run();
		expect(erodedEdges(ANA, 60, now).length).toBeGreaterThan(0);
		expect(edge(tide.id, ecology.id)).toBeTruthy();
	});
});

describe('what a write must not throw away', () => {
	it('keeps the learned half when the connection is re-described', () => {
		const { tide, ecology } = chain();
		rememberActivation(CHAT, ANA, activate({ userId: ANA, query: 'tide pools' }));
		learnFromReply(CHAT, 'Coastal ecology, specifically.');
		const learned = edge(tide.id, ecology.id).reinforcement;
		expect(learned).toBeGreaterThan(0);

		saveAssociation({
			sourceId: tide.id,
			targetId: ecology.id,
			description: 'a better sentence about why these connect',
			userId: ANA
		});
		// saveAssociation writes the whole row, so anything it does not carry
		// forward is silently reset — months of learning, in this case.
		expect(edge(tide.id, ecology.id).reinforcement).toBe(learned);
		expect(edge(tide.id, ecology.id).description).toContain('better sentence');
	});
});
