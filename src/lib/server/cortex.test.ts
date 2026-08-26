import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { db, runMigrations } from '$lib/server/db';
import { cortexAssociations, cortexChangeLog, cortexNodes } from '$lib/server/db/schema';
import {
	activate,
	exportLattice,
	findNodeByName,
	listAssociations,
	listChanges,
	saveAssociation,
	saveNode,
	seedNodes,
	cortexDigest,
	deleteNode
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
	it('says nothing at all when the lattice is empty', () => {
		expect(cortexDigest(ANA)).toBe('');
	});

	it('carries a count, never the concepts themselves', () => {
		seedChain();
		const digest = cortexDigest(ANA);
		expect(digest).toContain('4');
		// The Library learned this the expensive way: an index in the prompt, and
		// bodies only when something asks for them.
		expect(digest).not.toContain('Rockpool surveying');
		expect(digest).not.toContain('Tide pools');
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
	it('withholds cortex_write while agentWrites is off', () => {
		// Ships off: an agent minting nodes outruns anyone merging the duplicates,
		// and the groomer that would merge them does not exist yet.
		const names = cortexTools(ANA).map((t) => t.def.name);
		expect(names).toEqual(['cortex_query']);
	});

	it('offers it once the setting is on', () => {
		setSetting('cortex', { agentWrites: true });
		expect(cortexTools(ANA).map((t) => t.def.name)).toContain('cortex_write');
	});

	it('resolves an existing concept rather than creating a near-duplicate', async () => {
		setSetting('cortex', { agentWrites: true });
		saveNode({ name: 'Tide pools', ownerId: ANA });
		const write = cortexTools(ANA).find((t) => t.def.name === 'cortex_write')!;
		await write.execute({ name: 'tide pools', description: 'from the agent' });
		expect(db.select().from(cortexNodes).all()).toHaveLength(1);
	});

	it('says so when a new node was left unconnected', async () => {
		setSetting('cortex', { agentWrites: true });
		const write = cortexTools(ANA).find((t) => t.def.name === 'cortex_write')!;
		const out = await write.execute({ name: 'Tide pools' });
		expect(out).toMatch(/not surface/);
	});
});
