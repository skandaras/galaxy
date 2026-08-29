import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { db, runMigrations } from '$lib/server/db';
import { cortexAssociations, cortexChangeLog, cortexNodes } from '$lib/server/db/schema';
import {
	activate,
	deleteAssociation,
	mapProjection,
	mergeNodes,
	setNodeVisibility,
	exportLattice,
	findNodeByName,
	listAssociations,
	listChanges,
	saveAssociation,
	saveNode,
	seedNodes,
	cortexDigest,
	deleteNode,
	refreshLayout,
	circuitIndex,
	listCircuits,
	saveCircuit,
	deleteCircuit,
	exportPayload,
	comparisonContext,
	importLattice,
	revertRun,
	listAssociations as _listAssociations
} from '$lib/server/cortex';
import { setSetting } from '$lib/server/settings';
import { cortexTools } from '$lib/server/engine/tools/cortex';

const ANA = 'user-ana';

beforeAll(() => {
	runMigrations();
});

beforeEach(() => {
	db.delete(cortexAssociations).run();
	db.delete(cortexChangeLog).run();
	db.delete(cortexNodes).run();
	db.run(`DELETE FROM cortex_fts`);
	setSetting('cortex', {});
});

/** A small chain: tide-pools → coastal ecology → fieldwork, plus a stray. */
function seedChain() {
	const a = saveNode({ name: 'Tide pools', description: 'Rockpool surveying', ownerId: ANA });
	const b = saveNode({ name: 'Coastal ecology', description: 'Shoreline systems', ownerId: ANA });
	const c = saveNode({ name: 'Fieldwork', description: 'Working outdoors', ownerId: ANA });
	const d = saveNode({ name: 'Bookbinding', description: 'Unrelated craft', ownerId: ANA });
	saveAssociation({ sourceId: a.id, targetId: b.id, weight: 0.9, userId: ANA });
	saveAssociation({ sourceId: b.id, targetId: c.id, weight: 0.9, userId: ANA });
	return { a, b, c, d };
}

describe('nodes', () => {
	it('slugs an id from the name and resolves it back', () => {
		const node = saveNode({ name: 'Coastal ecology', ownerId: ANA });
		expect(node.id).toBe('coastal-ecology');
		expect(findNodeByName('coastal ecology', ANA)?.id).toBe(node.id);
	});

	it('updates an existing node rather than creating a twin', () => {
		saveNode({ name: 'Tide pools', description: 'first', ownerId: ANA });
		saveNode({ name: 'tide POOLS', description: 'second', ownerId: ANA });
		const all = db.select().from(cortexNodes).all();
		expect(all).toHaveLength(1);
		expect(all[0].description).toBe('second');
	});

	it('starts new nodes personal', () => {
		expect(saveNode({ name: 'Tide pools', ownerId: ANA }).visibility).toBe('personal');
	});

	it('refuses a node past the per-user cap', () => {
		setSetting('cortex', { maxNodesPerUser: 2 });
		saveNode({ name: 'One', ownerId: ANA });
		saveNode({ name: 'Two', ownerId: ANA });
		expect(() => saveNode({ name: 'Three', ownerId: ANA })).toThrow(/limit/);
	});

	it('takes its edges with it when deleted', () => {
		const { a } = seedChain();
		expect(deleteNode(a.id, ANA)).toBe(true);
		// Foreign keys are on, so a surviving edge would have failed the delete.
		expect(db.select().from(cortexAssociations).all().map((e) => e.sourceId)).not.toContain(a.id);
	});
});

describe('associations', () => {
	it('refuses to connect a node to itself', () => {
		const a = saveNode({ name: 'Tide pools', ownerId: ANA });
		expect(() => saveAssociation({ sourceId: a.id, targetId: a.id, userId: ANA })).toThrow();
	});

	it('clamps a weight into range', () => {
		const { a, d } = seedChain();
		const edge = saveAssociation({ sourceId: a.id, targetId: d.id, weight: 5, userId: ANA });
		expect(edge.weight).toBe(1);
	});

	it('stores a symmetric link once, whichever way round it is written', () => {
		const { a, b } = seedChain();
		saveAssociation({ sourceId: b.id, targetId: a.id, weight: 0.95, userId: ANA });
		const between = db
			.select()
			.from(cortexAssociations)
			.all()
			.filter((e) => [e.sourceId, e.targetId].includes(a.id) && [e.sourceId, e.targetId].includes(b.id));
		expect(between).toHaveLength(1);
		expect(between[0].weight).toBe(0.95);
	});

	it('does not deliver a doubled activation for one relationship', () => {
		// The bug this prevents: two rows for one symmetric link walked twice, so
		// activation arrived doubled and clamped at 1.0 — the far node looking
		// twice as relevant as it is.
		const a = saveNode({ name: 'Tide pools', description: 'rockpool', ownerId: ANA });
		const b = saveNode({ name: 'Coastal ecology', ownerId: ANA });
		saveAssociation({ sourceId: a.id, targetId: b.id, weight: 0.9, userId: ANA });
		saveAssociation({ sourceId: b.id, targetId: a.id, weight: 0.9, userId: ANA });
		const got = activate({ userId: ANA, query: 'rockpool' }).nodes.find((n) => n.node.id === b.id);
		expect(got!.activation).toBeCloseTo(0.9 * 0.7, 5);
	});

	it('keeps both directions of an asymmetric pair, which mean different things', () => {
		const { a, b } = seedChain();
		deleteAssociation(a.id, b.id, ANA);
		saveAssociation({ sourceId: a.id, targetId: b.id, weight: 0.9, directionality: 'asymmetric', userId: ANA });
		saveAssociation({ sourceId: b.id, targetId: a.id, weight: 0.2, directionality: 'asymmetric', userId: ANA });
		const between = db
			.select()
			.from(cortexAssociations)
			.all()
			.filter((e) => [e.sourceId, e.targetId].includes(a.id) && [e.sourceId, e.targetId].includes(b.id));
		expect(between).toHaveLength(2);
	});

	it('reads edges from both ends of a node', () => {
		const { b } = seedChain();
		expect(listAssociations(b.id, ANA)).toHaveLength(2);
	});
});

describe('seeding', () => {
	it('matches on the node text rather than a keyword map', () => {
		seedChain();
		expect(seedNodes('rockpool', ANA).map((n) => n.id)).toContain('tide-pools');
	});

	it('survives punctuation that would break raw FTS syntax', () => {
		seedChain();
		expect(() => seedNodes('tide "pools" OR (', ANA)).not.toThrow();
	});
});

describe('spreading activation', () => {
	it('reaches a node the query never named', () => {
		const { c } = seedChain();
		// "rockpool" only matches Tide pools. Fieldwork is two hops away and
		// arrives entirely through the mesh — the whole point of traversing.
		const ids = activate({ userId: ANA, query: 'rockpool' }).nodes.map((n) => n.node.id);
		expect(ids).toContain(c.id);
	});

	it('leaves unconnected concepts out', () => {
		const { d } = seedChain();
		const ids = activate({ userId: ANA, query: 'rockpool' }).nodes.map((n) => n.node.id);
		expect(ids).not.toContain(d.id);
	});

	it('falls off with distance', () => {
		const { a, c } = seedChain();
		const nodes = activate({ userId: ANA, query: 'rockpool' }).nodes;
		const near = nodes.find((n) => n.node.id === a.id)!;
		const far = nodes.find((n) => n.node.id === c.id)!;
		expect(near.activation).toBeGreaterThan(far.activation);
		expect(far.hops).toBeGreaterThan(near.hops);
	});

	it('does not follow an asymmetric edge backwards', () => {
		const a = saveNode({ name: 'Tide pools', description: 'Rockpool surveying', ownerId: ANA });
		const b = saveNode({ name: 'Bookbinding', ownerId: ANA });
		saveAssociation({
			sourceId: b.id,
			targetId: a.id,
			weight: 0.9,
			directionality: 'asymmetric',
			userId: ANA
		});
		const ids = activate({ userId: ANA, query: 'rockpool' }).nodes.map((n) => n.node.id);
		expect(ids).not.toContain(b.id);
	});

	it('can start from a node instead of a query', () => {
		const { a, c } = seedChain();
		const ids = activate({ userId: ANA, fromNodeId: a.id }).nodes.map((n) => n.node.id);
		expect(ids).toContain(c.id);
	});

	it('counts an activation without moving any weight', () => {
		const { a } = seedChain();
		const before = db.select().from(cortexAssociations).all().map((e) => e.weight);
		activate({ userId: ANA, query: 'rockpool' });
		const node = db.select().from(cortexNodes).all().find((n) => n.id === a.id)!;
		expect(node.activationCount).toBe(1);
		// Strengthening on co-retrieval would teach the lattice to confirm itself.
		expect(db.select().from(cortexAssociations).all().map((e) => e.weight)).toEqual(before);
	});
});

describe('the change log', () => {
	it('records every mutation, agent or not', () => {
		const { a, b } = seedChain();
		saveNode({ id: a.id, name: a.name, description: 'revised', ownerId: ANA, actor: 'agent' });
		const events = listChanges(ANA).map((c) => c.event);
		expect(events).toContain('created');
		expect(events).toContain('connected');
		expect(events).toContain('updated');
		expect(listChanges(ANA).find((c) => c.event === 'updated')?.actor).toBe('agent');
		expect(b.id).toBeTruthy();
	});

	it('keeps the prior state so a change can be undone', () => {
		const a = saveNode({ name: 'Tide pools', description: 'first', ownerId: ANA });
		saveNode({ id: a.id, name: a.name, description: 'second', ownerId: ANA });
		const update = listChanges(ANA).find((c) => c.event === 'updated')!;
		expect((update.before as { description: string }).description).toBe('first');
	});
});

describe('the context bootstrap line', () => {
	/** Insert straight to the table: this is about digest cost, not about writes. */
	function bulk(count: number, circuits: number) {
		const now = new Date();
		for (let i = 0; i < count; i++) {
			db.insert(cortexNodes)
				.values({
					id: `bulk-${i}`,
					ownerId: ANA,
					visibility: 'personal',
					name: `Concept number ${i} with a fairly typical name`,
					description: 'A description of roughly the length a real one would be.',
					circuits: [`circuit-${i % circuits}`],
					isConvergence: i % 40 === 0,
					activationPriority: 0.5,
					activationCount: 0,
					createdAt: now,
					updatedAt: now
				})
				.run();
		}
	}

	it('says nothing at all when the lattice is empty', () => {
		expect(cortexDigest(ANA)).toBe('');
	});

	it('names the concepts while the lattice is small', () => {
		seedChain();
		const digest = cortexDigest(ANA);
		// A handful of concepts needs the specifics to look worth querying, and
		// costs nothing. The old version showed a bare count, and an agent could
		// not tell whether querying would return anything relevant.
		expect(digest).toContain('Tide pools');
		expect(digest).toContain('Coastal ecology');
		// Names, never bodies — the Library learned that one the expensive way.
		expect(digest).not.toContain('Rockpool surveying');
	});

	it('calls itself a map of now, not a record of before', () => {
		// The reported bug: an agent read the lattice as an archive of past
		// events, so consulting it before answering never looked necessary.
		seedChain();
		const digest = cortexDigest(ANA).toLowerCase();
		expect(digest).toContain('map');
		expect(digest).toContain('currently true');
		expect(digest).toContain('not a record of past events');
	});

	it('stops listing names once there are too many to be cheap', () => {
		bulk(200, 8);
		const digest = cortexDigest(ANA);
		expect(digest).not.toContain('Concept number 7 ');
		expect(digest).toContain('circuit-0 (25)');
	});

	it('costs the same at a thousand concepts as at two hundred', () => {
		// The regression this whole block exists to prevent. Listing every node
		// would be ~22,000 characters at a thousand — some 5,500 tokens on every
		// single turn, worse than the wholesale injection the design was corrected
		// away from. Indexing by area makes the cost O(areas), not O(concepts).
		bulk(200, 20);
		const small = cortexDigest(ANA).length;
		db.delete(cortexNodes).run();
		bulk(1000, 20);
		const large = cortexDigest(ANA).length;

		// ~1.5KB, call it 375 tokens, for a thousand concepts — the same order as
		// the Library's forty-document index, and flat from here on.
		expect(large).toBeLessThan(1500);
		// Five times the lattice must not be five times the prompt.
		expect(large).toBeLessThan(small * 1.5);
	});

	it('always names the bridges, because they are the way in', () => {
		bulk(1000, 20);
		const digest = cortexDigest(ANA);
		expect(digest).toContain('Bridges between areas');
		// Capped even so: a lattice that has gone wrong should not be able to
		// flood the prompt through this line.
		expect(digest).toContain('more');
	});

	it('admits when it cannot show what is in there', () => {
		bulk(200, 1);
		db.update(cortexNodes).set({ circuits: null }).run();
		// Too many to list, nothing to group by. Saying so is the point — a bare
		// count is what caused the agent to ignore it in the first place.
		expect(cortexDigest(ANA)).toContain('No areas assigned yet');
	});
});

describe('the circuit index', () => {
	it('counts concepts per area and notices the unfiled', () => {
		saveNode({ name: 'One', ownerId: ANA, circuits: ['field'] });
		saveNode({ name: 'Two', ownerId: ANA, circuits: ['field'] });
		saveNode({ name: 'Three', ownerId: ANA });
		const index = circuitIndex(ANA);
		expect(index.circuits).toEqual([{ id: 'field', name: 'field', count: 2 }]);
		expect(index.unfiled).toBe(1);
	});

	it('counts a node in every area it belongs to', () => {
		saveNode({ name: 'One', ownerId: ANA, circuits: ['field', 'craft'] });
		expect(circuitIndex(ANA).circuits.map((c) => c.count)).toEqual([1, 1]);
	});
});

describe('export', () => {
	it('writes the visible lattice to disk as JSON', () => {
		seedChain();
		const out = exportLattice(ANA);
		expect(out.nodes).toBe(4);
		expect(out.edges).toBe(2);
		const parsed = JSON.parse(readFileSync(out.path, 'utf8'));
		expect(parsed.nodes).toHaveLength(4);
		expect(parsed.associations).toHaveLength(2);
	});
});

describe('the write gate', () => {
	it('offers cortex_write by default, now that grooming exists', () => {
		// It shipped off while there was no groomer to merge the near-duplicates
		// an agent would make. There is one now, merges are proposals, and since
		// areas became reviewed-only the most an unreviewed write can do is add an
		// unfiled concept.
		expect(cortexTools(ANA).map((t) => t.def.name)).toContain('cortex_write');
	});

	it('withholds it when the setting is off', () => {
		setSetting('cortex', { agentWrites: false });
		expect(cortexTools(ANA).map((t) => t.def.name)).toEqual(['cortex_query']);
	});

	it('resolves an existing concept rather than creating a near-duplicate', async () => {
		saveNode({ name: 'Tide pools', ownerId: ANA });
		const write = cortexTools(ANA).find((t) => t.def.name === 'cortex_write')!;
		await write.execute({ name: 'tide pools', description: 'from the agent' });
		expect(db.select().from(cortexNodes).all()).toHaveLength(1);
	});

	it('says so when a new node was left unconnected', async () => {
		const write = cortexTools(ANA).find((t) => t.def.name === 'cortex_write')!;
		const out = await write.execute({ name: 'Tide pools' });
		expect(out).toMatch(/not surface/);
	});
});

describe('disconnecting', () => {
	it('removes an edge and logs it', () => {
		const { a, b } = seedChain();
		expect(deleteAssociation(a.id, b.id, ANA)).toBe(true);
		expect(listAssociations(a.id, ANA)).toHaveLength(0);
		expect(listChanges(ANA).map((c) => c.event)).toContain('disconnected');
	});

	it('reports an edge that was not there', () => {
		const { a, d } = seedChain();
		expect(deleteAssociation(a.id, d.id, ANA)).toBe(false);
	});
});

describe('visibility', () => {
	it('shares a node and records what it was', () => {
		const a = saveNode({ name: 'Tide pools', ownerId: ANA });
		expect(setNodeVisibility(a.id, ANA, 'shared')?.visibility).toBe('shared');
		const entry = listChanges(ANA).find((c) => c.event === 'visibility')!;
		expect((entry.before as { visibility: string }).visibility).toBe('personal');
	});
});

describe('merging', () => {
	it('takes the absorbed node’s connections with it', () => {
		const { a, b, c } = seedChain();
		// a—b—c. Merging a into c should leave c connected to b.
		expect(mergeNodes(c.id, a.id, ANA)).toBeTruthy();
		expect(db.select().from(cortexNodes).all().map((n) => n.id)).not.toContain(a.id);
		const neighbours = listAssociations(c.id, ANA).map((e) =>
			e.sourceId === c.id ? e.targetId : e.sourceId
		);
		expect(neighbours).toContain(b.id);
	});

	it('keeps the stronger weight when both connected to the same node', () => {
		const a = saveNode({ name: 'Tide pools', ownerId: ANA });
		const dupe = saveNode({ name: 'Rockpools', ownerId: ANA });
		const shared = saveNode({ name: 'Coastal ecology', ownerId: ANA });
		saveAssociation({ sourceId: a.id, targetId: shared.id, weight: 0.3, userId: ANA });
		saveAssociation({ sourceId: dupe.id, targetId: shared.id, weight: 0.9, userId: ANA });
		mergeNodes(a.id, dupe.id, ANA);
		// A merge must never make the lattice remember less than it did.
		expect(listAssociations(a.id, ANA)[0].weight).toBe(0.9);
	});

	it('drops the edge that ran between the two', () => {
		const { a, b } = seedChain();
		mergeNodes(a.id, b.id, ANA);
		const neighbours = listAssociations(a.id, ANA).map((e) =>
			e.sourceId === a.id ? e.targetId : e.sourceId
		);
		expect(neighbours).not.toContain(a.id);
	});

	it('keeps the whole absorbed node so a wrong merge is answerable', () => {
		const { a, b } = seedChain();
		mergeNodes(a.id, b.id, ANA);
		const entry = listChanges(ANA).find((c) => c.event === 'merged')!;
		expect((entry.before as { name: string }).name).toBe('Coastal ecology');
	});

	it('refuses to merge a node into itself', () => {
		const { a } = seedChain();
		expect(mergeNodes(a.id, a.id, ANA)).toBeNull();
	});
});

describe('the map projection', () => {
	it('carries a degree so the chart can size a node', () => {
		const { b, d } = seedChain();
		const map = mapProjection(ANA);
		expect(map.nodes.find((n) => n.id === b.id)!.degree).toBe(2);
		expect(map.nodes.find((n) => n.id === d.id)!.degree).toBe(0);
	});

	it('sends positions, not whole rows', () => {
		seedChain();
		const node = mapProjection(ANA).nodes[0];
		expect(node).toHaveProperty('x');
		expect(node).not.toHaveProperty('activationCount');
	});
});

describe('the layout sweep', () => {
	it('lays the lattice out and stops', () => {
		seedChain();
		expect(refreshLayout().recomputed).toBe(true);

		// The trap this guards: the sweep writes x/y/z, and the signature is built
		// from updatedAt. Stamp updatedAt on a coordinate write and every tick
		// looks like a change, so the layout recomputes forever.
		expect(refreshLayout().recomputed).toBe(false);
		expect(refreshLayout().recomputed).toBe(false);
	});

	it('picks the work back up when the graph changes', () => {
		seedChain();
		refreshLayout();
		saveNode({ name: 'Kelp forests', ownerId: ANA });
		expect(refreshLayout().recomputed).toBe(true);
	});

	it('gives every node a position', () => {
		seedChain();
		refreshLayout();
		for (const node of db.select().from(cortexNodes).all()) {
			expect(node.x).not.toBeNull();
			expect(node.y).not.toBeNull();
			expect(node.z).not.toBeNull();
		}
	});

	it('does not move a node whose lattice did not change', () => {
		seedChain();
		refreshLayout();
		const before = db.select().from(cortexNodes).all().map((n) => `${n.id}:${n.x},${n.y}`);
		// A change elsewhere in the graph will move things — that is what a force
		// layout does — but an unchanged graph must produce an unchanged map.
		refreshLayout();
		expect(db.select().from(cortexNodes).all().map((n) => `${n.id}:${n.x},${n.y}`)).toEqual(before);
	});

	it('copes with an empty lattice', () => {
		expect(() => refreshLayout()).not.toThrow();
	});
});

describe('areas', () => {
	it('slugs an id from the name and reuses it on a second save', () => {
		const a = saveCircuit({ name: 'Coastal fieldwork', ownerId: ANA });
		expect(a.id).toBe('coastal-fieldwork');
		expect(saveCircuit({ name: 'coastal FIELDWORK', ownerId: ANA }).id).toBe(a.id);
		expect(listCircuits(ANA)).toHaveLength(1);
	});

	it('unfiles the nodes rather than deleting them', () => {
		const area = saveCircuit({ name: 'Coastal fieldwork', ownerId: ANA });
		const node = saveNode({ name: 'Tide pools', ownerId: ANA, circuits: [area.id] });
		expect(deleteCircuit(area.id, ANA)).toBe(true);
		// Deleting a label must never delete what was labelled.
		const after = db.select().from(cortexNodes).all().find((n) => n.id === node.id)!;
		expect(after).toBeTruthy();
		expect(after.circuits).toEqual([]);
	});

	it('refuses to delete someone else’s area', () => {
		const area = saveCircuit({ name: 'Coastal fieldwork', ownerId: ANA });
		expect(deleteCircuit(area.id, 'user-ben')).toBe(false);
	});

	it('shows up in the digest as an area with a count', () => {
		const area = saveCircuit({ name: 'Coastal fieldwork', ownerId: ANA });
		saveNode({ name: 'Tide pools', ownerId: ANA, circuits: [area.id] });
		saveNode({ name: 'Storm logs', ownerId: ANA, circuits: [area.id] });
		expect(cortexDigest(ANA)).toContain('Coastal fieldwork (2)');
	});
});

describe('the round trip', () => {
	it('comes back the same after export, wipe and import', () => {
		const area = saveCircuit({ name: 'Coastal fieldwork', ownerId: ANA });
		const { a, b } = seedChain();
		saveNode({ id: a.id, name: a.name, ownerId: ANA, circuits: [area.id] });
		const before = exportPayload(ANA);

		db.delete(cortexAssociations).run();
		db.delete(cortexNodes).run();
		db.run(`DELETE FROM cortex_fts`);

		const res = importLattice(ANA, before);
		expect(res.nodes).toBe(before.nodes.length);
		expect(res.edges).toBe(before.associations.length);

		const after = exportPayload(ANA);
		expect(after.nodes.map((n) => n.name).sort()).toEqual(
			before.nodes.map((n) => n.name).sort()
		);
		expect(after.associations).toHaveLength(before.associations.length);
		expect(b.id).toBeTruthy();
	});

	it('carries the areas, so the context index still has something to group by', () => {
		const area = saveCircuit({ name: 'Coastal fieldwork', ownerId: ANA });
		saveNode({ name: 'Tide pools', ownerId: ANA, circuits: [area.id] });
		const payload = exportPayload(ANA);

		db.delete(cortexNodes).run();
		importLattice(ANA, payload);
		expect(cortexDigest(ANA)).toContain('Coastal fieldwork');
	});

	it('updates rather than duplicating when imported over itself', () => {
		seedChain();
		const payload = exportPayload(ANA);
		// Names, not ids: a file cannot reach a row by guessing an id, and
		// importing over a lattice should not double it.
		importLattice(ANA, payload);
		expect(db.select().from(cortexNodes).all()).toHaveLength(payload.nodes.length);
	});

	it('drops a connection whose far end did not import', () => {
		const { a, b } = seedChain();
		const payload = exportPayload(ANA);
		payload.nodes = payload.nodes.filter((n) => n.id !== b.id);
		db.delete(cortexAssociations).run();
		db.delete(cortexNodes).run();
		db.run(`DELETE FROM cortex_fts`);

		const res = importLattice(ANA, payload);
		expect(res.skipped).toBeGreaterThan(0);
		expect(_listAssociations(a.id, ANA)).toHaveLength(0);
	});

	it('survives a file that is not a lattice at all', () => {
		expect(() => importLattice(ANA, { nodes: 'not an array' })).not.toThrow();
		expect(importLattice(ANA, {}).nodes).toBe(0);
		expect(importLattice(ANA, null).nodes).toBe(0);
	});

	it('lands as one run, so a bad import can be undone in one go', () => {
		const payload = { nodes: [{ name: 'Kelp forests' }, { name: 'Sea urchins' }] };
		const res = importLattice(ANA, payload);
		expect(res.nodes).toBe(2);
		expect(revertRun(res.runId, ANA)).toBeGreaterThan(0);
	});

	it('respects the concept cap rather than throwing halfway', () => {
		setSetting('cortex', { maxNodesPerUser: 2 });
		const res = importLattice(ANA, {
			nodes: [{ name: 'One' }, { name: 'Two' }, { name: 'Three' }, { name: 'Four' }]
		});
		expect(res.nodes).toBe(2);
		// A number telling you what did not fit beats half a lattice and a stack
		// trace.
		expect(res.skipped).toBe(2);
	});
});

describe('the comparison context', () => {
	it('carries the concepts a question activates, and what they relate to', () => {
		const { a, b } = seedChain();
		const { text, concepts } = comparisonContext(ANA, 'rockpool');
		expect(text).toContain('Tide pools');
		// Relationships, not just a list — that is the whole difference between
		// this and a search result, and so the thing being compared.
		expect(text).toContain('relates to:');
		expect(concepts.map((c) => c.id)).toContain(a.id);
		expect(concepts.map((c) => c.id)).toContain(b.id);
	});

	it('gives back nothing when nothing activates', () => {
		seedChain();
		const { text, concepts } = comparisonContext(ANA, 'quantum chromodynamics');
		// Both sides then get the same prompt, which is the honest outcome: the
		// comparison should show no difference rather than invent one.
		expect(text).toBe('');
		expect(concepts).toHaveLength(0);
	});
});

describe('what the write tool tells a model to do', () => {
	const write = () => cortexTools(ANA).find((t) => t.def.name === 'cortex_write')!;

	it('says when to reach for it, not only what it is', () => {
		// A description without a trigger reads as available-on-request. A model
		// given the first version went a whole conversation without noticing an
		// occasion, and said so when asked: no behavioural trigger, unlike every
		// skill description it had.
		const text = write().def.description.toLowerCase();
		expect(text).toContain('on your own initiative');
		expect(text).toContain('not only when asked');
		expect(text).toMatch(/reach for this when/);
	});

	it('calibrates the line against memory with something concrete', () => {
		const text = write().def.description.toLowerCase();
		// "A concept, not a fact" is the right rule and too abstract to apply.
		expect(text).toContain('belongs in memory');
		expect(text).toContain('edges');
	});

	it('carries no real person in its examples', () => {
		// The illustrations came from a live conversation. The shape transfers;
		// the content stays out of the repo, like the fixture.
		const text = write().def.description;
		expect(text).not.toMatch(/cosmopsychism|Vazza|Teilhard|noosphere/i);
	});
});
