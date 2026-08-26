import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { db, dataDir } from '$lib/server/db';
import {
	cortexAssociations,
	cortexChangeLog,
	cortexNodes,
	type cortexCircuits
} from '$lib/server/db/schema';
import { layout, layoutSignature } from '$lib/server/cortex-layout';
import { ftsQuery, slugify } from '$lib/server/library';
import { DEFAULT_CORTEX, getSetting, setSetting, type CortexSettings } from '$lib/server/settings';

export type CortexNode = typeof cortexNodes.$inferSelect;
export type CortexAssociation = typeof cortexAssociations.$inferSelect;
export type CortexCircuit = typeof cortexCircuits.$inferSelect;

const cortexDir = () => join(dataDir, 'cortex');

function settings(): CortexSettings {
	return { ...DEFAULT_CORTEX, ...getSetting<Partial<CortexSettings>>('cortex', {}) };
}

export function cortexWritesAllowed(): boolean {
	return settings().agentWrites;
}

// --- visibility -------------------------------------------------------------

/**
 * What one user may see: their own nodes, anything shared, and anything with no
 * owner at all (the same legacy case the Library carries).
 *
 * Every read goes through this. Cortex feeds an agent's system prompt, so an
 * unscoped query here is a privacy bug rather than a cosmetic one — the same
 * warning the Library earns, for the same reason.
 */
export function visibleTo(userId: string): SQL {
	return or(
		eq(cortexNodes.visibility, 'shared'),
		eq(cortexNodes.ownerId, userId),
		isNull(cortexNodes.ownerId)
	)!;
}

/** True when this user may change or delete the node — owners and legacy only. */
export function canEdit(node: Pick<CortexNode, 'ownerId'>, userId: string): boolean {
	return node.ownerId === null || node.ownerId === userId;
}

export function listNodes(userId: string): CortexNode[] {
	return db.select().from(cortexNodes).where(visibleTo(userId)).orderBy(cortexNodes.name).all();
}

export function getNode(id: string, userId: string): CortexNode | null {
	return (
		db
			.select()
			.from(cortexNodes)
			.where(and(eq(cortexNodes.id, id), visibleTo(userId)))
			.get() ?? null
	);
}

export function findNodeByName(name: string, userId: string): CortexNode | null {
	const n = name.trim().toLowerCase();
	return listNodes(userId).find((x) => x.name.toLowerCase() === n || x.id === slugify(name)) ?? null;
}

export function nodeCount(userId: string): number {
	return listNodes(userId).length;
}

// --- change log -------------------------------------------------------------

/**
 * Record a mutation. Called on every write path, including the ones a human
 * makes, so the log is the whole history rather than only what an agent did.
 *
 * `before` is what makes a change reversible. The grooming agent applies its
 * low-risk changes rather than queuing them, and "flagged for review" only
 * means something if the review can undo what it reads.
 */
export function logChange(entry: {
	nodeId?: string | null;
	actor?: 'user' | 'agent' | 'groom';
	userId?: string | null;
	event: string;
	detail?: string;
	before?: unknown;
}): void {
	db.insert(cortexChangeLog)
		.values({
			id: randomUUID(),
			nodeId: entry.nodeId ?? null,
			actor: entry.actor ?? 'user',
			userId: entry.userId ?? null,
			event: entry.event,
			detail: entry.detail ?? '',
			before: entry.before ?? null,
			createdAt: new Date()
		})
		.run();
}

export function listChanges(userId: string, limit = 100) {
	return db
		.select()
		.from(cortexChangeLog)
		.where(eq(cortexChangeLog.userId, userId))
		.orderBy(sql`${cortexChangeLog.createdAt} DESC`, cortexChangeLog.id)
		.limit(limit)
		.all();
}

// --- nodes ------------------------------------------------------------------

function syncFts(id: string, name: string, description: string): void {
	db.run(sql`DELETE FROM cortex_fts WHERE id = ${id}`);
	db.run(
		sql`INSERT INTO cortex_fts (id, name, description) VALUES (${id}, ${name}, ${description})`
	);
}

function uniqueId(base: string): string {
	let candidate = base;
	for (let i = 2; db.select().from(cortexNodes).where(eq(cortexNodes.id, candidate)).get(); i++) {
		candidate = `${base}-${i}`;
	}
	return candidate;
}

export function saveNode(opts: {
	id?: string;
	name: string;
	description?: string;
	modalities?: string[];
	circuits?: string[];
	activationPriority?: number;
	isConvergence?: boolean;
	/** Owner for a new node. Existing nodes keep the owner they have. */
	ownerId: string;
	/** New nodes start personal; sharing is a deliberate act. */
	visibility?: 'personal' | 'shared';
	actor?: 'user' | 'agent' | 'groom';
}): CortexNode {
	const now = new Date();
	const existing = opts.id
		? (db.select().from(cortexNodes).where(eq(cortexNodes.id, opts.id)).get() ?? null)
		: findNodeByName(opts.name, opts.ownerId);

	if (existing && !canEdit(existing, opts.ownerId)) {
		throw new Error(`"${existing.name}" belongs to someone else`);
	}
	if (!existing) {
		const cap = settings().maxNodesPerUser;
		if (nodeCount(opts.ownerId) >= cap) {
			throw new Error(`Lattice is at its ${cap}-node limit; merge or remove some first`);
		}
	}

	const id = existing?.id ?? uniqueId(slugify(opts.name));
	const row: CortexNode = {
		id,
		ownerId: existing ? existing.ownerId : opts.ownerId,
		visibility: existing ? existing.visibility : (opts.visibility ?? 'personal'),
		name: opts.name.trim() || id,
		description: opts.description ?? existing?.description ?? '',
		modalities: opts.modalities ?? existing?.modalities ?? null,
		circuits: opts.circuits ?? existing?.circuits ?? null,
		activationPriority: opts.activationPriority ?? existing?.activationPriority ?? 0.5,
		isConvergence: opts.isConvergence ?? existing?.isConvergence ?? false,
		// Written by the layout sweep, never here — a node that moved because its
		// description changed would make the map unreadable between visits.
		x: existing?.x ?? null,
		y: existing?.y ?? null,
		z: existing?.z ?? null,
		lastVerifiedAt: existing?.lastVerifiedAt ?? now,
		lastActivatedAt: existing?.lastActivatedAt ?? null,
		activationCount: existing?.activationCount ?? 0,
		createdAt: existing?.createdAt ?? now,
		updatedAt: now
	};

	if (existing) {
		db.update(cortexNodes).set(row).where(eq(cortexNodes.id, id)).run();
	} else {
		db.insert(cortexNodes).values(row).run();
	}
	syncFts(id, row.name, row.description);
	logChange({
		nodeId: id,
		actor: opts.actor ?? 'user',
		userId: opts.ownerId,
		event: existing ? 'updated' : 'created',
		detail: row.name,
		before: existing ?? undefined
	});
	return row;
}

export function deleteNode(id: string, userId: string, actor: 'user' | 'agent' | 'groom' = 'user') {
	const node = db.select().from(cortexNodes).where(eq(cortexNodes.id, id)).get();
	// Someone else's shared node is readable, not deletable.
	if (!node || !canEdit(node, userId)) return false;
	// Edges first: the foreign keys are enforced (see db/index.ts), so a node
	// with associations cannot simply vanish from under them.
	db.delete(cortexAssociations).where(eq(cortexAssociations.sourceId, id)).run();
	db.delete(cortexAssociations).where(eq(cortexAssociations.targetId, id)).run();
	db.delete(cortexNodes).where(eq(cortexNodes.id, id)).run();
	db.run(sql`DELETE FROM cortex_fts WHERE id = ${id}`);
	logChange({ nodeId: id, actor, userId, event: 'deleted', detail: node.name, before: node });
	return true;
}

// --- associations -----------------------------------------------------------

/**
 * Connect two nodes.
 *
 * Both endpoints must be visible to the caller and at least one must be theirs
 * to edit. The reader-side rule in `visibleEdges` is what protects traversal;
 * this is the write-side half — nobody builds an edge into a lattice they can
 * only read.
 */
export function saveAssociation(opts: {
	sourceId: string;
	targetId: string;
	weight?: number;
	contextTags?: string[];
	description?: string;
	directionality?: 'symmetric' | 'asymmetric';
	userId: string;
	actor?: 'user' | 'agent' | 'groom';
}): CortexAssociation {
	if (opts.sourceId === opts.targetId) throw new Error('A node cannot be connected to itself');
	const source = getNode(opts.sourceId, opts.userId);
	const target = getNode(opts.targetId, opts.userId);
	if (!source) throw new Error(`No node "${opts.sourceId}"`);
	if (!target) throw new Error(`No node "${opts.targetId}"`);
	if (!canEdit(source, opts.userId) && !canEdit(target, opts.userId)) {
		throw new Error('Neither end of that connection is yours to change');
	}

	const now = new Date();
	const existing = db
		.select()
		.from(cortexAssociations)
		.where(
			and(
				eq(cortexAssociations.sourceId, opts.sourceId),
				eq(cortexAssociations.targetId, opts.targetId)
			)
		)
		.get();

	const row: CortexAssociation = {
		sourceId: opts.sourceId,
		targetId: opts.targetId,
		weight: clamp(opts.weight ?? existing?.weight ?? 0.5),
		contextTags: opts.contextTags ?? existing?.contextTags ?? null,
		description: opts.description ?? existing?.description ?? '',
		directionality: opts.directionality ?? existing?.directionality ?? 'symmetric',
		createdAt: existing?.createdAt ?? now,
		lastTraversedAt: existing?.lastTraversedAt ?? null,
		traversalCount: existing?.traversalCount ?? 0
	};

	if (existing) {
		db.update(cortexAssociations)
			.set(row)
			.where(
				and(
					eq(cortexAssociations.sourceId, opts.sourceId),
					eq(cortexAssociations.targetId, opts.targetId)
				)
			)
			.run();
	} else {
		db.insert(cortexAssociations).values(row).run();
	}
	logChange({
		nodeId: opts.sourceId,
		actor: opts.actor ?? 'user',
		userId: opts.userId,
		event: 'connected',
		detail: `${source.name} → ${target.name}`,
		before: existing ?? undefined
	});
	return row;
}

const clamp = (n: number) => Math.max(0, Math.min(1, n));

/**
 * Every association where *both* endpoints are visible to this user.
 *
 * Scoped by construction rather than by filtering afterwards: the visible node
 * ids are resolved first and the edge query is bounded by them, so an edge with
 * one end in someone else's lattice is never loaded at all. That is the rule
 * that stops a shared node bridging two people's private ones — reachability,
 * not just readability.
 *
 * Loading the whole visible edge set per query is fine at the size this store is
 * meant to hold (a cap of a couple of thousand nodes, see CortexSettings). If it
 * ever isn't, the change is to walk it a hop at a time against the same id set,
 * not to relax the bound.
 */
export function visibleEdges(userId: string): CortexAssociation[] {
	const ids = listNodes(userId).map((n) => n.id);
	if (!ids.length) return [];
	return db
		.select()
		.from(cortexAssociations)
		.where(
			and(
				inArray(cortexAssociations.sourceId, ids),
				inArray(cortexAssociations.targetId, ids)
			)
		)
		.all();
}

export function listAssociations(nodeId: string, userId: string): CortexAssociation[] {
	return visibleEdges(userId).filter((e) => e.sourceId === nodeId || e.targetId === nodeId);
}

// --- retrieval --------------------------------------------------------------

/**
 * Seed nodes for a query.
 *
 * FTS over the node's own name and description, scored against its
 * activation priority. This replaces the keyword→circuit routing map the
 * original design used: a map is only as good as the entries someone remembered
 * to write, and its failure mode is silent — the query simply stops reaching the
 * right region of the lattice. Matching on the node's own text has no such gap,
 * and when embeddings arrive they drop into exactly this step.
 */
export function seedNodes(query: string, userId: string, limit = 6): CortexNode[] {
	// `any`, not `all`. A question is not a keyword list: the first version of
	// this ANDed the terms, so anything phrased differently from the node it
	// should have matched returned no seed whatsoever — and with no seed there is
	// nothing to spread from, so the whole traversal silently produced nothing.
	// The eval found this on its first run; every failing query failed here.
	const match = ftsQuery(query.trim(), 'any');
	if (!match) return [];
	const hits = db.all<{ id: string }>(
		sql`SELECT id FROM cortex_fts WHERE cortex_fts MATCH ${match} ORDER BY rank LIMIT ${limit * 4}`
	);
	// Scoped by construction: only visible nodes are in the map, so an FTS hit on
	// someone else's personal node is dropped here.
	const visible = new Map(listNodes(userId).map((n) => [n.id, n]));
	// Relevance leads, priority nudges. Sorting by priority alone threw away the
	// ranking FTS had just done, so a node that barely matched outranked the one
	// the question was about; sorting by rank alone makes priority dead weight.
	// Multiplying by (0.5 + priority) lets a node the lattice considers important
	// climb a place or two without ever leapfrogging a much better match.
	const rank = new Map(hits.map((h, i) => [h.id, i]));
	const relevance = (n: CortexNode) =>
		(1 / (1 + rank.get(n.id)!)) * (0.5 + n.activationPriority);
	return hits
		.map((h) => visible.get(h.id))
		.filter((n): n is CortexNode => !!n)
		.sort((a, b) => relevance(b) - relevance(a))
		.slice(0, limit);
}

export interface ActivatedNode {
	node: CortexNode;
	activation: number;
	hops: number;
}

export interface ActivationResult {
	seeds: string[];
	nodes: ActivatedNode[];
}

/**
 * How much of a source node's activation crosses one edge, before the edge's
 * own weight. Two iterations with this decay means a node three hops out needs
 * strong edges the whole way to survive the threshold, which is the intent.
 *
 * These four constants are untuned. They are the first plausible values, not
 * derived ones, and they stay that way until the eval fixture exists to say
 * whether a change helped — see docs/CORTEX.md, "Knowing whether it works".
 * Please don't tune them by feel; there is nothing yet to tune against.
 */
const DECAY = 0.7;
const THRESHOLD = 0.1;
const ITERATIONS = 2;
const MAX_RESULTS = 12;

/**
 * What a convergence node gets for being one — and why this is **off by
 * default**.
 *
 * Boosting the bridges is the design's central claim, so it was built and
 * measured. On the eval fixture it buys nothing: convergence recall is 1.00
 * with it and 1.00 without, and turning it on costs about two points of
 * precision by reordering answers that were already right. A mechanism that
 * only reorders, and reorders slightly worse, does not earn its default.
 *
 * The honest caveat is that the fixture cannot show the case it was designed
 * for. Bridges already surface there, so there is no headroom to demonstrate;
 * a larger, denser lattice where a bridge is genuinely hard to reach might tell
 * a different story. So the mechanism stays, opt-in, with the finding recorded
 * — and cortex-eval.test.ts holds the comparison, so flipping the default
 * requires showing it helps rather than assuming it does.
 */
const CONVERGENCE_BOOST = 1.25;

/**
 * What an edge keeps when its context tags miss the query's entirely.
 *
 * Attenuation, not a cut. An edge tagged `craft` is still a real connection
 * when someone asks a field question — it is just less likely to be what they
 * meant, and a lattice that severed it would lose the cross-domain reach that
 * is the point of having one.
 */
const GATE_MISS = 0.6;

/**
 * Spreading activation over the visible sub-lattice.
 *
 * Seeds start at 1.0 and push activation to their neighbours, attenuated by the
 * edge weight and the decay above; whatever is still above the threshold after
 * a couple of passes is what the query gets back. A node reached by two
 * different paths accumulates from both, which is the whole reason this is a
 * traversal and not a search — it is how a concept nothing in the query
 * mentioned ends up in the answer.
 *
 * Contextual gating and the convergence-node boost land in P2, once the eval
 * can show what they are worth.
 */
export function activate(opts: {
	userId: string;
	query?: string;
	fromNodeId?: string;
	depth?: number;
	limit?: number;
	/** Defaults on: measured as a small gain at no cost. */
	gating?: boolean;
	/** Defaults **off**: measured as no gain at a small cost. See CONVERGENCE_BOOST. */
	convergenceBoost?: boolean;
}): ActivationResult {
	const seeds = opts.fromNodeId
		? [getNode(opts.fromNodeId, opts.userId)].filter((n): n is CortexNode => !!n)
		: seedNodes(opts.query ?? '', opts.userId);
	if (!seeds.length) return { seeds: [], nodes: [] };

	const byId = new Map(listNodes(opts.userId).map((n) => [n.id, n]));
	const edges = visibleEdges(opts.userId);

	// Adjacency built once per query. An asymmetric edge only carries activation
	// the way it points: one concept can strongly imply another while the reverse
	// is weak, and flattening that would make every specific node as loud as the
	// general one it feeds.
	const out = new Map<string, { to: string; weight: number; tags: string[] | null }[]>();
	const push = (from: string, to: string, weight: number, tags: string[] | null) => {
		out.set(from, [...(out.get(from) ?? []), { to, weight, tags }]);
	};
	for (const e of edges) {
		push(e.sourceId, e.targetId, e.weight, e.contextTags);
		if (e.directionality === 'symmetric') push(e.targetId, e.sourceId, e.weight, e.contextTags);
	}

	// The query's context, taken from where it landed rather than asked for: the
	// modalities of the seed nodes. Nothing new has to be passed in, and it says
	// something true — these are the domains the question turned out to be about.
	const context = new Set(seeds.flatMap((s) => s.modalities ?? []));
	const gate = (tags: string[] | null): number => {
		if (opts.gating === false || !tags?.length || !context.size) return 1;
		return tags.some((t) => context.has(t)) ? 1 : GATE_MISS;
	};

	const activation = new Map<string, number>();
	const hops = new Map<string, number>();
	for (const s of seeds) {
		activation.set(s.id, 1);
		hops.set(s.id, 0);
	}

	const rounds = Math.max(1, Math.min(opts.depth ?? ITERATIONS, 4));
	let frontier = seeds.map((s) => s.id);
	for (let i = 0; i < rounds && frontier.length; i++) {
		const next: string[] = [];
		for (const id of frontier) {
			const source = activation.get(id) ?? 0;
			for (const edge of out.get(id) ?? []) {
				// The second of two guards on the same rule, and deliberately so.
				// `byId` holds only what this reader may see, so a node outside that
				// is skipped here even if an edge somehow reached it — `visibleEdges`
				// already bounds the edge set, and a privacy boundary is worth
				// holding in both the query and the walk. Either one alone is
				// sufficient; both means a mistake in one is not a disclosure.
				const target = byId.get(edge.to);
				if (!target) continue;
				const boost =
					opts.convergenceBoost === true && target.isConvergence ? CONVERGENCE_BOOST : 1;
				const delivered = source * edge.weight * DECAY * gate(edge.tags) * boost;
				if (delivered < THRESHOLD) continue;
				const prior = activation.get(edge.to) ?? 0;
				// Accumulate rather than overwrite: arriving from two directions is
				// exactly what should make a node matter more, not the same amount.
				const total = Math.min(1, prior + delivered);
				if (total <= prior) continue;
				activation.set(edge.to, total);
				if (!hops.has(edge.to)) hops.set(edge.to, i + 1);
				next.push(edge.to);
			}
		}
		frontier = [...new Set(next)];
	}

	const nodes = [...activation.entries()]
		.filter(([, v]) => v >= THRESHOLD)
		.map(([id, v]) => ({ node: byId.get(id)!, activation: v, hops: hops.get(id) ?? 0 }))
		.filter((a) => !!a.node)
		.sort((a, b) => b.activation - a.activation)
		.slice(0, opts.limit ?? MAX_RESULTS);

	recordActivation(nodes.map((n) => n.node.id));
	return { seeds: seeds.map((s) => s.id), nodes };
}

/**
 * Note that these nodes fired. Counts and timestamps only — no weights move.
 *
 * Strengthening on co-retrieval would reinforce the traversal's own output,
 * teaching the lattice to confirm the shape it already has. When learning
 * arrives it reinforces on whether a turn actually *used* what it was given,
 * which the run trace already records.
 */
function recordActivation(ids: string[]): void {
	if (!ids.length) return;
	db.update(cortexNodes)
		.set({
			lastActivatedAt: new Date(),
			activationCount: sql`${cortexNodes.activationCount} + 1`
		})
		.where(inArray(cortexNodes.id, ids))
		.run();
}

// --- context and export -----------------------------------------------------

/**
 * The lattice's line in the context bootstrap: that it exists and how big it
 * is, nothing more.
 *
 * The original design pushed an activated subgraph — five to fifteen kilobytes
 * — into every conversation's opening context. This platform has already paid
 * for that mistake twice: once in the coding agent's session block (see
 * engine/context.ts, where it cost a cache hit on every leg of every turn) and
 * once in the Library digest, which used to carry a snippet of every document.
 * A catalogue line costs nothing per turn and the tool fetches what a question
 * actually needs.
 */
export function cortexDigest(userId: string): string {
	const count = nodeCount(userId);
	if (!count) return '';
	return [
		'',
		`[Cortex — a knowledge lattice of ${count} linked concept${count === 1 ? '' : 's'}. ` +
			'Not a document store: it holds how things connect. Query it with cortex_query when ' +
			'a question leans on background you would otherwise have to guess at.]'
	].join('\n');
}

/**
 * Everything this user can see, as JSON on disk.
 *
 * JSON rather than the YAML the original design named: there is no yaml package
 * here, the dependency list is deliberately short, and the map (P2) is a much
 * better answer to "let me look at what's in there" than any text format. Lands
 * beside library/ and skills/ under DATA_DIR, and is never committed.
 */
export function exportLattice(userId: string): { path: string; nodes: number; edges: number } {
	mkdirSync(cortexDir(), { recursive: true });
	const nodes = listNodes(userId);
	const edges = visibleEdges(userId);
	const path = join(cortexDir(), `${slugify(userId)}.json`);
	writeFileSync(
		path,
		JSON.stringify({ exportedAt: new Date().toISOString(), nodes, associations: edges }, null, 2)
	);
	return { path, nodes: nodes.length, edges: edges.length };
}

/** Disconnect two nodes. Owner-scoped through the same rule as connecting. */
export function deleteAssociation(
	sourceId: string,
	targetId: string,
	userId: string,
	actor: 'user' | 'agent' | 'groom' = 'user'
): boolean {
	const source = getNode(sourceId, userId);
	const target = getNode(targetId, userId);
	if (!source || !target) return false;
	if (!canEdit(source, userId) && !canEdit(target, userId)) return false;
	const res = db
		.delete(cortexAssociations)
		.where(
			and(eq(cortexAssociations.sourceId, sourceId), eq(cortexAssociations.targetId, targetId))
		)
		.run();
	if (!res.changes) return false;
	logChange({
		nodeId: sourceId,
		actor,
		userId,
		event: 'disconnected',
		detail: `${source.name} ⇢ ${target.name}`
	});
	return true;
}

/** Change who can see a node. Only its owner (or a legacy node) can be changed. */
export function setNodeVisibility(
	id: string,
	userId: string,
	visibility: 'personal' | 'shared'
): CortexNode | null {
	const node = db.select().from(cortexNodes).where(eq(cortexNodes.id, id)).get();
	if (!node || !canEdit(node, userId)) return null;
	db.update(cortexNodes)
		// Claim a legacy node on first change, so it stops being everyone's.
		.set({ visibility, ownerId: node.ownerId ?? userId, updatedAt: new Date() })
		.where(eq(cortexNodes.id, id))
		.run();
	logChange({
		nodeId: id,
		userId,
		event: 'visibility',
		detail: `${node.name}: ${node.visibility} → ${visibility}`,
		before: node
	});
	return db.select().from(cortexNodes).where(eq(cortexNodes.id, id)).get() ?? null;
}

/**
 * Fold one node into another, taking its connections with it.
 *
 * The answer to the duplicate problem, and the reason it exists before the
 * grooming agent does: a lattice being shaped by hand accumulates "Tide pools"
 * and "Rockpools" within a week, and without this the only remedy is deleting
 * one and rebuilding its edges by hand — which nobody does, so the duplicates
 * stay.
 *
 * Edges move rather than merge away: where both nodes connected to the same
 * third node the stronger weight wins, because a merge should never make the
 * lattice remember *less* about a relationship than it did before.
 */
export function mergeNodes(
	keepId: string,
	mergeId: string,
	userId: string,
	actor: 'user' | 'agent' | 'groom' = 'user'
): CortexNode | null {
	if (keepId === mergeId) return null;
	const keep = getNode(keepId, userId);
	const merge = getNode(mergeId, userId);
	if (!keep || !merge) return null;
	if (!canEdit(keep, userId) || !canEdit(merge, userId)) {
		throw new Error('Both nodes must be yours to merge');
	}

	const existing = new Map(
		listAssociations(keepId, userId).map((e) => [e.sourceId === keepId ? e.targetId : e.sourceId, e])
	);

	for (const edge of listAssociations(mergeId, userId)) {
		const otherId = edge.sourceId === mergeId ? edge.targetId : edge.sourceId;
		if (otherId === keepId) continue; // an edge between the two simply goes
		const already = existing.get(otherId);
		saveAssociation({
			sourceId: keepId,
			targetId: otherId,
			weight: Math.max(edge.weight, already?.weight ?? 0),
			contextTags: edge.contextTags ?? already?.contextTags ?? undefined,
			description: already?.description || edge.description || undefined,
			userId,
			actor
		});
	}

	// Delete the node last: its edges are gone by now, and the foreign keys are
	// enforced, so anything left behind fails loudly rather than silently.
	db.delete(cortexAssociations).where(eq(cortexAssociations.sourceId, mergeId)).run();
	db.delete(cortexAssociations).where(eq(cortexAssociations.targetId, mergeId)).run();
	db.delete(cortexNodes).where(eq(cortexNodes.id, mergeId)).run();
	db.run(sql`DELETE FROM cortex_fts WHERE id = ${mergeId}`);

	logChange({
		nodeId: keepId,
		actor,
		userId,
		event: 'merged',
		detail: `${merge.name} → ${keep.name}`,
		// The whole absorbed node, so a wrong merge is answerable.
		before: merge
	});
	return getNode(keepId, userId);
}

export interface MapNode {
	id: string;
	name: string;
	description: string;
	x: number | null;
	y: number | null;
	z: number | null;
	isConvergence: boolean;
	visibility: 'personal' | 'shared';
	circuits: string[] | null;
	degree: number;
}

export interface MapEdge {
	source: string;
	target: string;
	weight: number;
}

/**
 * The projection the chart draws: what this user may see, and nothing else.
 *
 * Deliberately not the whole row. The map needs a position, a label and a
 * shape, so that is what crosses the wire — and a viewer whose lattice is a
 * subset of a larger one gets a subset here too, laid out inside whatever
 * bounds their own nodes occupy.
 */
export function mapProjection(userId: string): { nodes: MapNode[]; edges: MapEdge[] } {
	const nodes = listNodes(userId);
	const edges = visibleEdges(userId);
	const degree = new Map<string, number>();
	for (const e of edges) {
		degree.set(e.sourceId, (degree.get(e.sourceId) ?? 0) + 1);
		degree.set(e.targetId, (degree.get(e.targetId) ?? 0) + 1);
	}
	return {
		nodes: nodes.map((n) => ({
			id: n.id,
			name: n.name,
			description: n.description,
			x: n.x,
			y: n.y,
			z: n.z,
			isConvergence: n.isConvergence,
			visibility: n.visibility,
			circuits: n.circuits,
			degree: degree.get(n.id) ?? 0
		})),
		edges: edges.map((e) => ({ source: e.sourceId, target: e.targetId, weight: e.weight }))
	};
}


const LAYOUT_SIGNATURE_KEY = 'cortex.layoutSignature';

/**
 * Recompute where every node sits, if the graph has moved since last time.
 *
 * Global, not per viewer, because coordinates live on the node row and a node
 * cannot sensibly be in two places. Someone who sees a subset of the lattice
 * therefore gets a subset of a larger layout — the map fits and re-centres to
 * whatever bounds their own nodes occupy, so relative structure survives and
 * clusters stay clustered.
 *
 * The signature check is the whole reason this can sit on a five-minute tick: a
 * layout is the expensive half of any graph view, and almost every tick will
 * find nothing has changed.
 */
export function refreshLayout(): { recomputed: boolean; nodes: number; edges: number } {
	const nodes = db.select().from(cortexNodes).all();
	const edges = db.select().from(cortexAssociations).all();
	const latest = nodes.reduce((m, n) => Math.max(m, n.updatedAt?.getTime() ?? 0), 0);
	const signature = layoutSignature(nodes.length, edges.length, latest);
	if (getSetting<string>(LAYOUT_SIGNATURE_KEY, '') === signature) {
		return { recomputed: false, nodes: nodes.length, edges: edges.length };
	}

	const points = layout(
		nodes.map((n) => ({ id: n.id })),
		edges.map((e) => ({ source: e.sourceId, target: e.targetId, weight: e.weight }))
	);
	for (const [id, p] of points) {
		// Deliberately not touching updatedAt. It feeds the signature above, so
		// stamping it here would make every sweep look like a change and the
		// layout would recompute forever.
		db.update(cortexNodes).set({ x: p.x, y: p.y, z: p.z }).where(eq(cortexNodes.id, id)).run();
	}
	setSetting(LAYOUT_SIGNATURE_KEY, signature);
	return { recomputed: true, nodes: nodes.length, edges: edges.length };
}
