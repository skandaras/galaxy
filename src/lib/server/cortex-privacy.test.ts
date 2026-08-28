import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { db, runMigrations } from '$lib/server/db';
import { cortexAssociations, cortexChangeLog, cortexNodes } from '$lib/server/db/schema';
import {
	activate,
	circuitIndex,
	comparisonContext,
	cortexDigest,
	mapProjection,
	mergeNodes,
	importLattice,
	exportPayload,
	exportLattice,
	listNodes,
	saveAssociation,
	saveNode,
	seedNodes,
	visibleEdges
} from '$lib/server/cortex';
import { setSetting } from '$lib/server/settings';
import { bootstrapContext } from '$lib/server/engine/tools/knowledge';
import { cortexTools } from '$lib/server/engine/tools/cortex';

/**
 * Cortex reaches an agent's system prompt, which puts it in the same class as
 * the Library and memory: an unscoped read is a privacy bug, not a cosmetic one.
 *
 * Scoping rows is the easy half. The half worth testing is *reachability* — a
 * lattice is a mesh, so a node one person shares can sit between two private
 * ones and quietly become a bridge between two people's heads. Activation must
 * stop at the boundary rather than pass through it.
 *
 * These tests fail loudly on the pull request when that stops being true.
 */

const ANA = 'user-ana';
const BEN = 'user-ben';

// Distinctive enough that a substring check over a whole payload is meaningful.
const ANA_SECRET = 'quokkasunrise-ana-marker';
const BEN_SECRET = 'narwhalthursday-ben-marker';
const BRIDGE = 'shared-bridge-concept';

beforeAll(() => {
	runMigrations();
});

/**
 * Ana's private node and Ben's private node, both hung off one node Ana shares.
 * Every edge here is legitimate — Ben may connect his own node to something
 * shared with him. The question is whether either can now reach the other.
 */
beforeEach(() => {
	db.delete(cortexAssociations).run();
	db.delete(cortexChangeLog).run();
	db.delete(cortexNodes).run();
	db.run(`DELETE FROM cortex_fts`);
	setSetting('cortex', { agentWrites: true });

	const bridge = saveNode({
		name: BRIDGE,
		description: 'A concept deliberately shared with everyone',
		ownerId: ANA,
		visibility: 'shared'
	});
	const anaNode = saveNode({ name: ANA_SECRET, description: `${ANA_SECRET} detail`, ownerId: ANA });
	const benNode = saveNode({ name: BEN_SECRET, description: `${BEN_SECRET} detail`, ownerId: BEN });

	saveAssociation({ sourceId: anaNode.id, targetId: bridge.id, weight: 0.95, userId: ANA });
	saveAssociation({ sourceId: benNode.id, targetId: bridge.id, weight: 0.95, userId: BEN });
});

describe('reading', () => {
	it('shows each person their own nodes plus what is shared', () => {
		const names = listNodes(ANA).map((n) => n.name);
		expect(names).toContain(ANA_SECRET);
		expect(names).toContain(BRIDGE);
		expect(names).not.toContain(BEN_SECRET);
	});

	it('drops an FTS hit on someone else’s private node', () => {
		expect(seedNodes(BEN_SECRET, ANA)).toHaveLength(0);
		expect(seedNodes(BEN_SECRET, BEN)).toHaveLength(1);
	});

	it('never loads an edge with one end outside what the reader can see', () => {
		// Ben's edge into the bridge exists and is his to have. It must simply not
		// be part of the graph Ana traverses.
		expect(db.select().from(cortexAssociations).all()).toHaveLength(2);
		expect(visibleEdges(ANA)).toHaveLength(1);
		expect(visibleEdges(BEN)).toHaveLength(1);
	});
});

describe('traversal across an ownership boundary', () => {
	it('reaches the shared node but stops there', () => {
		const ids = activate({ userId: ANA, query: ANA_SECRET }).nodes.map((n) => n.node.id);
		expect(ids).toContain('shared-bridge-concept');
		expect(ids.join(' ')).not.toContain(BEN_SECRET);
	});

	it('holds in the other direction too', () => {
		const ids = activate({ userId: BEN, query: BEN_SECRET }).nodes.map((n) => n.node.id);
		expect(ids).toContain('shared-bridge-concept');
		expect(ids.join(' ')).not.toContain(ANA_SECRET);
	});

	it('will not use a hidden node as a conduit to a visible one', () => {
		// The test that proves reachability is bounded, rather than the result
		// filter standing in for it.
		//
		// It asserts the *guarantee*, not one mechanism: two independent guards
		// now hold it — the edge query in `visibleEdges` and the visible-node
		// lookup in the traversal — so removing either one alone leaves this
		// green. That is defence in depth working as intended, and it is worth
		// knowing when reading a passing run: only removing both trips this.
		//
		// Ana → bridge → [Ben's private node] → a second shared node. Every node
		// at the far end is one Ana may see, so dropping invisible rows from the
		// *result* cannot save her here: if activation walks the middle hop, the
		// far node shows up and Ana has learned a relationship that exists only
		// inside Ben's lattice. Nothing may cross, not even in passing.
		const far = saveNode({
			name: 'far-shared-concept',
			description: 'Also shared with everyone',
			ownerId: BEN,
			visibility: 'shared'
		});
		const benNodeId = db
			.select()
			.from(cortexNodes)
			.all()
			.find((n) => n.name === BEN_SECRET)!.id;
		saveAssociation({ sourceId: benNodeId, targetId: far.id, weight: 1, userId: BEN });

		const ids = activate({ userId: ANA, query: ANA_SECRET, depth: 4 }).nodes.map((n) => n.node.id);
		expect(ids).toContain('shared-bridge-concept');
		expect(ids).not.toContain(far.id);

		// And the far node is genuinely reachable for its own side, so the
		// assertion above is about the boundary and not about an unreachable node.
		const benIds = activate({ userId: BEN, query: BEN_SECRET, depth: 4 }).nodes.map(
			(n) => n.node.id
		);
		expect(benIds).toContain(far.id);
	});

	it('will not walk through the bridge even when started from it', () => {
		// The direct attempt: stand on the shared node and spread outward. Ana
		// should see only her own side of it.
		const ids = activate({ userId: ANA, fromNodeId: 'shared-bridge-concept' }).nodes.map(
			(n) => n.node.id
		);
		expect(ids.join(' ')).not.toContain(BEN_SECRET);
	});
});

describe('what leaves the module', () => {
	it('keeps the other person out of the context bootstrap', () => {
		// Prepended to the system prompt of every chat and coding turn.
		const context = bootstrapContext(ANA);
		expect(context).not.toContain(BEN_SECRET);
	});

	it('keeps the other person out of a tool result', async () => {
		const query = cortexTools(ANA).find((t) => t.def.name === 'cortex_query')!;
		const out = await query.execute({ query: ANA_SECRET });
		expect(out).toContain(BRIDGE);
		expect(out).not.toContain(BEN_SECRET);
	});

	it('reports counts to the Observatory, never concepts', async () => {
		// The Observatory is shared with admins, so what a tool reports about a
		// private store is held to the same rule the alignment module keeps:
		// that something happened, never any of what it said.
		const query = cortexTools(ANA).find((t) => t.def.name === 'cortex_query')!;
		let reported: Record<string, unknown> = {};
		await query.execute({ query: ANA_SECRET }, (meta) => {
			reported = meta;
		});
		expect(Object.keys(reported).length).toBeGreaterThan(0);
		const serialised = JSON.stringify(reported);
		expect(serialised).not.toContain(ANA_SECRET);
		expect(serialised).not.toContain(BRIDGE);
	});

	it('keeps the other person out of the map', () => {
		// A visualisation renders whatever it is handed, so the projection is the
		// place this has to hold — by the time it is pixels there is no check left.
		const map = mapProjection(ANA);
		const serialised = JSON.stringify(map);
		expect(serialised).toContain(BRIDGE);
		expect(serialised).not.toContain(BEN_SECRET);
		// And the edge into Ben's lattice is not there to be drawn either.
		expect(map.edges).toHaveLength(1);
	});

	it('will not render someone else’s label for their shared node', () => {
		// The API takes free strings for circuits, so the id is usually the label
		// itself. Ben shares a node — its *name* is legitimately Ana's to see,
		// that is what sharing means — but the area he filed it under is his.
		const shared = saveNode({
			name: 'A concept ben shares',
			description: 'Visible to everyone by design',
			ownerId: BEN,
			visibility: 'shared'
		});
		db.update(cortexNodes)
			.set({ circuits: [`${BEN_SECRET}-area`] })
			.where(eq(cortexNodes.id, shared.id))
			.run();

		const index = circuitIndex(ANA);
		expect(JSON.stringify(index.circuits)).not.toContain(BEN_SECRET);
		expect(cortexDigest(ANA)).not.toContain(BEN_SECRET);

		// Ben's own view still shows him his own label.
		expect(JSON.stringify(circuitIndex(BEN).circuits)).toContain(BEN_SECRET);
	});

	it('keeps the other person out of a comparison', () => {
		// A new way to render the lattice into a prompt, and so a new way to
		// render the wrong one.
		//
		// A surface check rather than a bound test: comparisonContext goes through
		// `activate`, so what actually protects it is the conduit case above. If
		// that one ever goes green wrongly, this will not catch it.
		const { text, concepts } = comparisonContext(ANA, BEN_SECRET);
		expect(text).not.toContain(BEN_SECRET);
		expect(JSON.stringify(concepts)).not.toContain(BEN_SECRET);
	});

	it('keeps the other person out of an export', () => {
		const out = exportLattice(ANA);
		const raw = readFileSync(out.path, 'utf8');
		expect(raw).toContain(ANA_SECRET);
		expect(raw).not.toContain(BEN_SECRET);
	});
});

describe('importing a file', () => {
	it('ignores the owner named in the file and uses the person importing', () => {
		// A payload naming somebody else is not a request, it is an attempt.
		const res = importLattice(ANA, {
			nodes: [{ id: 'planted', name: 'Planted concept', ownerId: BEN, visibility: 'shared' }]
		});
		expect(res.nodes).toBe(1);
		const planted = db
			.select()
			.from(cortexNodes)
			.all()
			.find((n) => n.name === 'Planted concept')!;
		expect(planted.ownerId).toBe(ANA);
	});

	it('cannot reach another person’s concept by naming its id', () => {
		const benNode = db
			.select()
			.from(cortexNodes)
			.all()
			.find((n) => n.name === BEN_SECRET)!;

		importLattice(ANA, {
			nodes: [{ id: benNode.id, name: 'Overwritten by ana', description: 'should not land' }]
		});

		// Ids in a file are hints, not claims: nodes resolve by name through the
		// ordinary write path, so guessing an id reaches nothing.
		const after = db
			.select()
			.from(cortexNodes)
			.all()
			.find((n) => n.id === benNode.id)!;
		expect(after.name).toBe(BEN_SECRET);
		expect(after.ownerId).toBe(BEN);
	});

	it('will not claim a shared concept by importing over its name', () => {
		const res = importLattice(ANA, {
			nodes: [{ name: BRIDGE, description: 'rewritten by ana' }]
		});
		// The bridge is Ana's own here, so this one legitimately updates — the
		// case that must not work is the one above, and the one below.
		expect(res.nodes).toBe(1);

		const benOwned = db
			.select()
			.from(cortexNodes)
			.all()
			.find((n) => n.name === BEN_SECRET)!;
		expect(benOwned.description).toContain(BEN_SECRET);
	});

	it('does not let an export of one lattice carry another’s', () => {
		const payload = exportPayload(ANA);
		expect(JSON.stringify(payload)).not.toContain(BEN_SECRET);
	});
});

describe('writing across a boundary', () => {
	it('refuses to connect to a node the writer cannot see', () => {
		const benNodeId = db
			.select()
			.from(cortexNodes)
			.all()
			.find((n) => n.name === BEN_SECRET)!.id;
		expect(() =>
			saveAssociation({ sourceId: 'shared-bridge-concept', targetId: benNodeId, userId: ANA })
		).toThrow();
	});

	it('refuses to edit someone else’s node, shared or not', () => {
		expect(() => saveNode({ name: BRIDGE, description: 'rewritten', ownerId: BEN })).toThrow(
			/someone else/
		);
	});

	it('refuses to merge across an ownership boundary, without saying why', () => {
		const benNodeId = db
			.select()
			.from(cortexNodes)
			.all()
			.find((n) => n.name === BEN_SECRET)!.id;

		// Null, not a throw — and that is the stronger behaviour, not a weaker
		// one. "That node is not yours" would confirm the node exists; a node Ana
		// cannot see should be indistinguishable from a node that is not there.
		// The refusal to disclose is the same rule as the refusal to traverse.
		expect(mergeNodes('shared-bridge-concept', benNodeId, ANA)).toBeNull();

		// And the point of the refusal: merging destroys a node, so Ben's has to
		// still be standing afterwards.
		const survivor = db
			.select()
			.from(cortexNodes)
			.all()
			.find((n) => n.id === benNodeId);
		expect(survivor).toBeTruthy();
		expect(survivor!.name).toBe(BEN_SECRET);
	});

	it('will not silently claim a node by writing over its name', async () => {
		// The agent path, not the store path: Ben's agent naming Ana's shared
		// concept must not end up rewriting it.
		const write = cortexTools(BEN).find((t) => t.def.name === 'cortex_write')!;
		await expect(write.execute({ name: BRIDGE, description: 'rewritten by ben' })).rejects.toThrow();
		const bridge = db
			.select()
			.from(cortexNodes)
			.all()
			.find((n) => n.name === BRIDGE)!;
		expect(bridge.description).not.toContain('rewritten');
	});
});
