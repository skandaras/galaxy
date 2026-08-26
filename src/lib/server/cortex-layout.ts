/**
 * Where the nodes sit on the map.
 *
 * Pure on purpose — nodes and edges in, coordinates out, no database. That is
 * what makes the claim the whole design rests on testable rather than merely
 * asserted: the second pass must leave the first pass's x and y *identical*,
 * and a function you can call twice with the same input is how you prove it.
 *
 * Two passes, and the second is the interesting one.
 *
 * Position is never captured when a node or a relation is created. It cannot
 * be: a coordinate fixed at creation would be wrong the moment anything else
 * connected to either end. Position is a rendering of the whole graph, derived
 * after the fact, which is why nothing is lost by computing it late.
 *
 * What *is* lost by computing z late is stability. A native 2D layout and a
 * native 3D layout put nodes in genuinely different places, so adding depth
 * later would move everything — throwing away the spatial memory that was the
 * reason to precompute coordinates at all, at exactly the point the lattice is
 * finally big enough for that memory to be worth something.
 *
 * So x and y come from a true 2D layout, and z is a constrained pass that
 * relaxes depth *while holding x and y fixed*. Turning on a 3D view then lifts
 * the nodes out of the plane rather than reshuffling them, and z carries a
 * meaning of its own: how much a node's placement was compromised by
 * flattening — which is to say, where the 2D map is lying to you.
 *
 * The trade is that this is a 3D layout anchored to a 2D one rather than a
 * native 3D layout, which might pack marginally better. Not worth a reshuffle.
 */

export interface LayoutNode {
	id: string;
}

export interface LayoutEdge {
	source: string;
	target: string;
	weight: number;
}

export interface Point {
	x: number;
	y: number;
	z: number;
}

const ITERATIONS = 300;
/**
 * How much harder an edge pulls than the ambient repulsion pushes.
 *
 * Plain Fruchterman-Reingold spreads a small graph almost evenly, which is
 * legible but says nothing — and a map whose only job is to show the shape of
 * the mesh has to make a cluster look like one. Raising attraction tightens
 * connected groups without changing what the layout means, because the
 * equilibrium distance still falls out of the edge weight.
 */
const ATTRACTION = 2.2;

/**
 * A weak pull toward the middle.
 *
 * Nothing else holds a disconnected node in place: repulsion pushes it away
 * from the cluster and no edge pulls it back, so it drifts until the cooling
 * schedule runs out. One orphan just sits in a corner; several stretch the
 * bounding box until the connected part of the lattice is squeezed into a
 * fraction of the canvas.
 *
 * That matters more than tidiness. Spotting orphans is one of the things this
 * map is *for* — a node nothing connects to is dead weight in every query — and
 * an orphan is no use as a signal if it has drifted off the edge of the view or
 * flattened everything else to get there. Weak enough not to disturb the
 * clusters, strong enough to keep everything on screen.
 */
const GRAVITY = 0.012;
/** Depth is a correction to a flat layout, not a third full dimension. */
const Z_ITERATIONS = 60;
const Z_SCALE = 0.35;

/**
 * Deterministic pseudo-random in [0, 1) from a string.
 *
 * Not Math.random: the layout has to come out the same every time it is
 * recomputed, or the map moves under someone every few minutes and never
 * becomes something they can navigate from memory.
 */
function hash01(s: string): number {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return (h >>> 0) / 4294967296;
}

export function layout(
	nodes: LayoutNode[],
	edges: LayoutEdge[],
	/**
	 * `depth: false` stops after the 2D pass. Mostly so the tests can prove the
	 * depth pass leaves x and y untouched — which is the property the whole
	 * no-reshuffle argument rests on, and therefore not something to take on
	 * trust.
	 */
	opts: { depth?: boolean } = {}
): Map<string, Point> {
	const out = new Map<string, Point>();
	if (!nodes.length) return out;
	if (nodes.length === 1) {
		out.set(nodes[0].id, { x: 0, y: 0, z: 0 });
		return out;
	}

	const n = nodes.length;
	// A canvas big enough that the ideal edge length is a sane number. The client
	// fits to whatever bounds it receives, so the absolute scale is arbitrary and
	// only the ratios matter.
	const side = Math.sqrt(n) * 60;
	// Fruchterman-Reingold's ideal separation: the distance at which attraction
	// and repulsion balance.
	const k = Math.sqrt((side * side) / n);

	const index = new Map(nodes.map((node, i) => [node.id, i]));
	const xs = new Float64Array(n);
	const ys = new Float64Array(n);
	const zs = new Float64Array(n);

	for (let i = 0; i < n; i++) {
		const id = nodes[i].id;
		xs[i] = (hash01(id) - 0.5) * side;
		ys[i] = (hash01(`${id}#y`) - 0.5) * side;
		// A deterministic nudge off the plane. Without it every node sits at z=0,
		// the depth component of every force is exactly zero, and the second pass
		// has no symmetry to break — it would run and change nothing.
		zs[i] = (hash01(`${id}#z`) - 0.5) * k * 0.02;
	}

	const links = edges
		.map((e) => ({ a: index.get(e.source), b: index.get(e.target), w: e.weight }))
		.filter((l): l is { a: number; b: number; w: number } => l.a !== undefined && l.b !== undefined);

	const dx = new Float64Array(n);
	const dy = new Float64Array(n);

	// --- pass 1: a true 2D layout ------------------------------------------
	let temperature = side / 10;
	for (let iter = 0; iter < ITERATIONS; iter++) {
		dx.fill(0);
		dy.fill(0);

		// Repulsion, over a uniform grid rather than every pair. Cells are two
		// ideal-lengths wide, so anything close enough to matter is in the cell or
		// one of its neighbours, and the cost stops being quadratic in the node
		// count without changing the result meaningfully.
		const cell = k * 2;
		const buckets = new Map<string, number[]>();
		for (let i = 0; i < n; i++) {
			const key = `${Math.floor(xs[i] / cell)},${Math.floor(ys[i] / cell)}`;
			buckets.set(key, [...(buckets.get(key) ?? []), i]);
		}
		for (const [key, members] of buckets) {
			const [cx, cy] = key.split(',').map(Number);
			const near: number[] = [];
			for (let gx = cx - 1; gx <= cx + 1; gx++) {
				for (let gy = cy - 1; gy <= cy + 1; gy++) {
					const found = buckets.get(`${gx},${gy}`);
					if (found) near.push(...found);
				}
			}
			for (const i of members) {
				for (const j of near) {
					if (i === j) continue;
					let ddx = xs[i] - xs[j];
					let ddy = ys[i] - ys[j];
					let dist = Math.hypot(ddx, ddy);
					if (dist < 0.01) {
						// Two nodes exactly on top of each other have no direction to
						// separate along; nudge deterministically rather than randomly.
						ddx = (hash01(`${i}:${j}`) - 0.5) * 0.1;
						ddy = (hash01(`${j}:${i}`) - 0.5) * 0.1;
						dist = Math.hypot(ddx, ddy) || 0.01;
					}
					const force = (k * k) / dist;
					dx[i] += (ddx / dist) * force;
					dy[i] += (ddy / dist) * force;
				}
			}
		}

		// Attraction along edges, scaled by weight: a strong association should
		// pull its ends closer than a weak one, which is what makes a cluster on
		// the map mean something about the lattice rather than about the drawing.
		for (const l of links) {
			const ddx = xs[l.a] - xs[l.b];
			const ddy = ys[l.a] - ys[l.b];
			const dist = Math.hypot(ddx, ddy) || 0.01;
			const force = ((dist * dist) / k) * l.w * ATTRACTION;
			const fx = (ddx / dist) * force;
			const fy = (ddy / dist) * force;
			dx[l.a] -= fx;
			dy[l.a] -= fy;
			dx[l.b] += fx;
			dy[l.b] += fy;
		}

		for (let i = 0; i < n; i++) {
			dx[i] -= xs[i] * GRAVITY;
			dy[i] -= ys[i] * GRAVITY;
			const disp = Math.hypot(dx[i], dy[i]) || 1;
			// Cooling: large rearrangements early, small corrections late.
			const step = Math.min(disp, temperature);
			xs[i] += (dx[i] / disp) * step;
			ys[i] += (dy[i] / disp) * step;
		}
		temperature *= 0.95;
	}

	// --- pass 2: depth only, x and y frozen --------------------------------
	//
	// Nothing below writes xs or ys.
	//
	// The rule is local: a pair squeezed together in the *plane* separates in
	// depth, and everything else settles back toward zero. That is what makes z
	// mean "how much this node's placement was compromised by flattening" rather
	// than just "a third coordinate".
	//
	// An earlier version reused the 2D forces here — repulsion and edge
	// attraction on the full 3D distance — and got the sign of the whole thing
	// backwards: 3D distance is dominated by planar separation, so two nodes far
	// apart on the map exerted an enormous depth-attraction on each other for no
	// reason, and the nodes with the *most* room ended up with the most depth.
	// Forces that are meant to be local have to be local in the axis that
	// matters.
	const dz = new Float64Array(n);
	const near = k * 1.5;
	const cell = near;
	for (let iter = 0; opts.depth !== false && iter < Z_ITERATIONS; iter++) {
		dz.fill(0);
		const buckets = new Map<string, number[]>();
		for (let i = 0; i < n; i++) {
			const key = `${Math.floor(xs[i] / cell)},${Math.floor(ys[i] / cell)}`;
			buckets.set(key, [...(buckets.get(key) ?? []), i]);
		}
		for (const [key, members] of buckets) {
			const [cx, cy] = key.split(',').map(Number);
			const neighbours: number[] = [];
			for (let gx = cx - 1; gx <= cx + 1; gx++) {
				for (let gy = cy - 1; gy <= cy + 1; gy++) {
					const found = buckets.get(`${gx},${gy}`);
					if (found) neighbours.push(...found);
				}
			}
			for (const i of members) {
				for (const j of neighbours) {
					if (i === j) continue;
					const planar = Math.hypot(xs[i] - xs[j], ys[i] - ys[j]);
					if (planar >= near) continue;
					// 1 when two nodes sit on top of each other, 0 at the point they
					// have all the room they need. Squared so that genuine overlap
					// dominates and mild proximity barely registers.
					const crowding = (1 - planar / near) ** 2;
					const gap = zs[i] - zs[j];
					dz[i] += Math.sign(gap || 1) * crowding * k * 0.5;
				}
			}
		}
		const step = k * 0.05;
		for (let i = 0; i < n; i++) {
			// Depth is a correction, not a free dimension: without something
			// pulling it back, a node with any crowding at all drifts outward
			// forever and z stops being comparable between nodes.
			zs[i] += Math.max(-step, Math.min(step, dz[i] - zs[i] * 0.25));
		}
	}

	// Centre everything, and keep depth a correction rather than a third axis of
	// equal weight — the 2D map stays the map, and z is the part it cannot show.
	const cx = mean(xs);
	const cy = mean(ys);
	const cz = mean(zs);
	for (let i = 0; i < n; i++) {
		out.set(nodes[i].id, {
			x: round(xs[i] - cx),
			y: round(ys[i] - cy),
			z: round((zs[i] - cz) * Z_SCALE)
		});
	}
	return out;
}

const mean = (a: Float64Array) => a.reduce((s, v) => s + v, 0) / (a.length || 1);
/** Two decimals is well past what a screen can show, and keeps the JSON small. */
const round = (v: number) => Math.round(v * 100) / 100;

/**
 * A cheap description of the graph's shape, so the sweep can skip a recompute
 * when nothing has changed. Counts plus the latest edit: enough to catch an
 * added node, a removed edge or a renamed concept, and it costs one query
 * rather than a layout.
 */
export function layoutSignature(nodeCount: number, edgeCount: number, latestUpdate: number): string {
	return `${nodeCount}:${edgeCount}:${latestUpdate}`;
}
