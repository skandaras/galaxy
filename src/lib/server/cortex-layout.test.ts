import { describe, expect, it } from 'vitest';
import { layout, layoutSignature, type LayoutEdge, type LayoutNode } from '$lib/server/cortex-layout';

const nodes = (...ids: string[]): LayoutNode[] => ids.map((id) => ({ id }));
const edge = (source: string, target: string, weight = 0.8): LayoutEdge => ({
	source,
	target,
	weight
});

/** A hub with many spokes, plus a pair off on their own. */
function crowdedAndRoomy() {
	const spokes = Array.from({ length: 12 }, (_, i) => `spoke-${i}`);
	return {
		nodes: nodes('hub', ...spokes, 'lonely-a', 'lonely-b'),
		edges: [...spokes.map((s) => edge('hub', s)), edge('lonely-a', 'lonely-b')]
	};
}

/**
 * A graph with a real density gradient: a fully-connected clique packs as tight
 * as the layout allows, a weakly-linked chain strings out with room to spare.
 *
 * Hub-and-spokes will not do for this. Every spoke ends up the same distance
 * from every other, so "crowded" and "roomy" differ by a few percent and any
 * split between them is splitting noise — which is exactly how an earlier
 * version of the depth test managed to fail while the mechanism was working.
 */
function denseAndSparse() {
	const dense = Array.from({ length: 9 }, (_, i) => `dense-${i}`);
	const loose = Array.from({ length: 6 }, (_, i) => `loose-${i}`);
	const edges: LayoutEdge[] = [];
	for (let i = 0; i < dense.length; i++) {
		for (let j = i + 1; j < dense.length; j++) edges.push(edge(dense[i], dense[j], 1));
	}
	for (let i = 0; i < loose.length - 1; i++) edges.push(edge(loose[i], loose[i + 1], 0.25));
	edges.push(edge('dense-0', 'loose-0', 0.25));
	return { nodes: nodes(...dense, ...loose), edges };
}

describe('determinism', () => {
	it('gives the same answer every time', () => {
		// Recomputed every few minutes by the sweep. If this drifts, the map moves
		// under someone and can never become something they navigate from memory.
		const { nodes: n, edges: e } = crowdedAndRoomy();
		expect([...layout(n, e)]).toEqual([...layout(n, e)]);
	});

	it('does not depend on the order nodes arrive in', () => {
		const { nodes: n, edges: e } = crowdedAndRoomy();
		const forward = layout(n, e);
		const reversed = layout([...n].reverse(), e);
		for (const [id, p] of forward) {
			expect(reversed.get(id)!.x).toBeCloseTo(p.x, 6);
			expect(reversed.get(id)!.y).toBeCloseTo(p.y, 6);
		}
	});
});

describe('the depth pass', () => {
	it('leaves x and y exactly as the 2D pass left them', () => {
		// The property the no-reshuffle argument rests on. If this ever fails,
		// turning on a 3D view moves every node and the map has to be relearned.
		const { nodes: n, edges: e } = crowdedAndRoomy();
		const flat = layout(n, e, { depth: false });
		const deep = layout(n, e);
		for (const [id, p] of flat) {
			expect(deep.get(id)!.x).toBe(p.x);
			expect(deep.get(id)!.y).toBe(p.y);
		}
	});

	it('gives depth to whatever the plane had to squeeze', () => {
		// z means "how much this node's placement was compromised by flattening",
		// so this asserts that relationship directly — nodes with the least room
		// in the plane against nodes with the most — rather than naming two nodes
		// and assuming which will be which.
		const { nodes: n, edges: e } = denseAndSparse();
		const out = layout(n, e);
		const points = [...out.entries()];

		// How much room each node actually got: distance to its nearest neighbour
		// in the plane, which is the thing z is supposed to be compensating for.
		const room = points.map(([id, p]) => ({
			id,
			z: Math.abs(p.z),
			gap: Math.min(
				...points.filter(([other]) => other !== id).map(([, q]) => Math.hypot(p.x - q.x, p.y - q.y))
			)
		}));
		const byRoom = [...room].sort((a, b) => a.gap - b.gap);
		const half = Math.floor(byRoom.length / 2);
		const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

		const crowded = mean(byRoom.slice(0, half).map((r) => r.z));
		const roomy = mean(byRoom.slice(-half).map((r) => r.z));
		expect(crowded).toBeGreaterThan(roomy);
	});

	it('is flat when asked to be', () => {
		const { nodes: n, edges: e } = crowdedAndRoomy();
		for (const [, p] of layout(n, e, { depth: false })) {
			expect(Math.abs(p.z)).toBeLessThan(1);
		}
	});
});

describe('the 2D layout', () => {
	it('puts connected nodes nearer than unconnected ones', () => {
		const n = nodes('a', 'b', 'far');
		const out = layout(n, [edge('a', 'b', 0.9)]);
		const gap = (p: string, q: string) =>
			Math.hypot(out.get(p)!.x - out.get(q)!.x, out.get(p)!.y - out.get(q)!.y);
		expect(gap('a', 'b')).toBeLessThan(gap('a', 'far'));
	});

	it('centres on the origin, so the client only has to scale', () => {
		const { nodes: n, edges: e } = crowdedAndRoomy();
		const out = [...layout(n, e).values()];
		const cx = out.reduce((s, p) => s + p.x, 0) / out.length;
		expect(Math.abs(cx)).toBeLessThan(0.5);
	});
});

describe('nodes nothing connects to', () => {
	it('keeps an orphan in view rather than letting it drift away', () => {
		// Spotting an orphan is one of the things the map is for, and an orphan
		// that has drifted off the edge — or flattened everything else to get
		// there — is no use as a signal.
		const { nodes: n, edges: e } = crowdedAndRoomy();
		const out = layout([...n, { id: 'orphan-1' }, { id: 'orphan-2' }], e);
		const spread = Math.max(...[...out.values()].map((p) => Math.hypot(p.x, p.y)));
		const orphan = Math.hypot(out.get('orphan-1')!.x, out.get('orphan-1')!.y);
		// Outside the crowd, since nothing holds it there — but not off in space.
		expect(orphan).toBeLessThanOrEqual(spread);
		expect(orphan / spread).toBeGreaterThan(0.3);
	});
});

describe('degenerate input', () => {
	it('handles an empty lattice', () => {
		expect(layout([], []).size).toBe(0);
	});

	it('handles one node', () => {
		expect(layout(nodes('only'), [])).toEqual(new Map([['only', { x: 0, y: 0, z: 0 }]]));
	});

	it('ignores an edge pointing at a node that is not there', () => {
		// The map is a scoped projection, so an edge can legitimately name a node
		// the caller filtered out. Laying that out must not throw.
		expect(() => layout(nodes('a', 'b'), [edge('a', 'ghost')])).not.toThrow();
	});

	it('separates nodes that would otherwise land on the same spot', () => {
		const out = layout(nodes('a', 'b', 'c'), []);
		const points = [...out.values()];
		expect(Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y)).toBeGreaterThan(1);
	});
});

describe('the signature', () => {
	it('changes when the graph does', () => {
		expect(layoutSignature(10, 20, 5)).not.toBe(layoutSignature(11, 20, 5));
		expect(layoutSignature(10, 20, 5)).not.toBe(layoutSignature(10, 21, 5));
		expect(layoutSignature(10, 20, 5)).not.toBe(layoutSignature(10, 20, 6));
	});

	it('is stable when it does not', () => {
		expect(layoutSignature(10, 20, 5)).toBe(layoutSignature(10, 20, 5));
	});
});
