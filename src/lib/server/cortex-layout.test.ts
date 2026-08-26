import { describe, expect, it } from 'vitest';
import { layout, layoutSignature, type LayoutEdge, type LayoutNode } from '$lib/server/cortex-layout';

const nodes = (...ids: string[]): LayoutNode[] => ids.map((id) => ({ id }));
const edge = (source: string, target: string, weight = 0.8): LayoutEdge => ({
	source,
	target,
	weight
});

/** A hub with many spokes crowds; a lone pair does not. */
function crowdedAndRoomy() {
	const spokes = Array.from({ length: 12 }, (_, i) => `spoke-${i}`);
	return {
		nodes: nodes('hub', ...spokes, 'lonely-a', 'lonely-b'),
		edges: [...spokes.map((s) => edge('hub', s)), edge('lonely-a', 'lonely-b')]
	};
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

	it('pushes crowded nodes out of the plane and leaves roomy ones alone', () => {
		// z means "how much this node's placement was compromised by flattening",
		// so the twelve spokes fighting for room around one hub should have it and
		// the pair off on their own should not.
		const { nodes: n, edges: e } = crowdedAndRoomy();
		const out = layout(n, e);
		const spokeDepth =
			[...out].filter(([id]) => id.startsWith('spoke-')).reduce((m, [, p]) => m + Math.abs(p.z), 0) /
			12;
		const lonelyDepth = (Math.abs(out.get('lonely-a')!.z) + Math.abs(out.get('lonely-b')!.z)) / 2;
		expect(spokeDepth).toBeGreaterThan(lonelyDepth);
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
