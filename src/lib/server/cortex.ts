import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { db, dataDir } from '$lib/server/db';
import {
	cortexAssociations,
	cortexChangeLog,
	cortexCircuits,
	cortexNodes
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
 * Node names are listed only while a lattice is small enough for the list to be
 * cheap. Past this it is indexed by circuit instead — see cortexDigest.
 */
const DIGEST_NAME_LIMIT = 40;
/**
 * Bridges are few by design, but a runaway lattice should not prove otherwise —
 * and named concepts are the most expensive thing in this block, so the cap is
 * what keeps the whole digest bounded rather than merely finite.
 */
const DIGEST_BRIDGE_CAP = 8;

export interface CircuitSummary {
	id: string;
	name: string;
	count: number;
}

/**
 * What areas this person's lattice covers, and how much sits in each.
 *
 * A node's `circuits` array holds ids, but the API accepts free strings, so an
 * entry with no matching row is shown as itself rather than dropped — a label
 * someone typed is still a label.
 */
export function circuitIndex(userId: string): { circuits: CircuitSummary[]; unfiled: number } {
	// Only this reader's own circuit rows. The first version read the whole
	// table, which meant a node someone else shared could render *their* label
	// in *this* person's prompt — and since the API accepts free strings, the id
	// is often the label, so there was no safe half to show either.
	const named = new Map(
		db
			.select()
			.from(cortexCircuits)
			.where(or(eq(cortexCircuits.ownerId, userId), isNull(cortexCircuits.ownerId))!)
			.all()
			.map((c) => [c.id, c.name])
	);
	const counts = new Map<string, number>();
	let unfiled = 0;
	for (const node of listNodes(userId)) {
		// A label written on your own node is yours to see. A label on a node
		// somebody shared with you is theirs, and only surfaces if it resolves to
		// a circuit you also keep — otherwise the node counts as unfiled here,
		// which is what it is from where you are standing.
		const mine = node.ownerId === userId || node.ownerId === null;
		const on = (node.circuits ?? []).filter((id) => mine || named.has(id));
		if (!on.length) {
			unfiled++;
			continue;
		}
		for (const id of on) counts.set(id, (counts.get(id) ?? 0) + 1);
	}
	return {
		circuits: [...counts.entries()]
			.map(([id, count]) => ({ id, name: named.get(id) ?? id, count }))
			.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
		unfiled
	};
}

/**
 * The lattice's line in the context bootstrap.
 *
 * This block earns its place twice over, and the first version failed at both.
 *
 * **It has to say what the lattice is.** An agent that read the old wording
 * treated Cortex as an archive of past events — something to consult if a
 * question happened to be about history — and answered from its own priors
 * instead. It is not a log. It is the current map of the person being spoken
 * to, and the framing has to say so in the present tense.
 *
 * **It has to say what is in there.** Every other store puts instance data in
 * the prompt: the Library lists document titles, boards are named, memories are
 * quoted. Cortex used to carry a bare count, so an agent could not tell whether
 * querying would return anything relevant — a gamble with unknown payoff, which
 * is a gamble most turns decline.
 *
 * The obvious fix, listing every node, does not survive arithmetic: a thousand
 * nodes is around 22,000 characters, some 5,500 tokens on *every* turn, which
 * is worse than the wholesale context injection this design was corrected away
 * from in the first place. So the index is by circuit and its cost is O(areas),
 * not O(concepts) — the same shape the Library's folder grouping takes, and the
 * scalability the original design claimed for a tiered index without ever
 * building one.
 *
 * Names are still listed while a lattice is small, because a handful of
 * concepts needs the specifics to look worth querying and costs nothing.
 */
export function cortexDigest(userId: string): string {
	const nodes = listNodes(userId);
	if (!nodes.length) return '';

	const bridges = nodes.filter((n) => n.isConvergence);
	const { circuits, unfiled } = circuitIndex(userId);
	const lines = [
		'',
		'[Cortex — the working map of this person: ' +
			`${nodes.length} concept${nodes.length === 1 ? '' : 's'}` +
			(circuits.length ? ` across ${circuits.length} area${circuits.length === 1 ? '' : 's'}` : '') +
			', and how they connect. Not a record of past events — this is what is currently true ' +
			'of them, their work and their world.'
	];

	if (circuits.length) {
		lines.push(
			'  Areas: ' + circuits.map((c) => `${c.name} (${c.count})`).join(' · ') +
				(unfiled ? ` · unfiled (${unfiled})` : '')
		);
	}

	if (nodes.length <= DIGEST_NAME_LIMIT) {
		lines.push('  Concepts: ' + nodes.map((n) => n.name).join(' · '));
	} else if (!circuits.length) {
		// Nothing to group by and too many to list. Say so rather than silently
		// offering a number, which is the failure this whole block exists to fix.
		lines.push(
			'  No areas assigned yet, so this index cannot show what is in there — ' +
				'assign circuits to concepts and it will.'
		);
	}

	if (bridges.length) {
		const shown = bridges.slice(0, DIGEST_BRIDGE_CAP).map((b) => b.name);
		lines.push(
			'  Bridges between areas: ' +
				shown.join(' · ') +
				(bridges.length > shown.length ? ` and ${bridges.length - shown.length} more` : '')
		);
	}

	lines.push(
		'Call cortex_query with what the conversation is about whenever the answer depends on ' +
			'who this person is — which is most things that are not purely factual. It returns the ' +
			'concepts that bear on it and how they relate, including ones you would not have known ' +
			'to ask for.]'
	);
	return lines.join('\n');
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


// --- circuits ---------------------------------------------------------------

/**
 * Areas of the lattice: a label for grouping, and what the context digest is
 * indexed by. Deliberately not a routing key — seeding goes through FTS, so a
 * circuit can be renamed, split or abandoned without touching retrieval.
 */
export function listCircuits(userId: string): CortexCircuit[] {
	return db
		.select()
		.from(cortexCircuits)
		.where(or(eq(cortexCircuits.ownerId, userId), isNull(cortexCircuits.ownerId))!)
		.orderBy(cortexCircuits.name)
		.all();
}

export function saveCircuit(opts: {
	id?: string;
	name: string;
	description?: string;
	ownerId: string;
}): CortexCircuit {
	const name = opts.name.trim();
	if (!name) throw new Error('name is required');
	const existing = opts.id
		? db.select().from(cortexCircuits).where(eq(cortexCircuits.id, opts.id)).get()
		: listCircuits(opts.ownerId).find((c) => c.name.toLowerCase() === name.toLowerCase());
	if (existing && existing.ownerId !== null && existing.ownerId !== opts.ownerId) {
		throw new Error('That area belongs to someone else');
	}

	const row: CortexCircuit = {
		id: existing?.id ?? uniqueCircuitId(slugify(name)),
		ownerId: existing ? existing.ownerId : opts.ownerId,
		name,
		description: opts.description ?? existing?.description ?? '',
		createdAt: existing?.createdAt ?? new Date()
	};
	if (existing) {
		db.update(cortexCircuits).set(row).where(eq(cortexCircuits.id, row.id)).run();
	} else {
		db.insert(cortexCircuits).values(row).run();
	}
	return row;
}

function uniqueCircuitId(base: string): string {
	let candidate = base;
	for (
		let i = 2;
		db.select().from(cortexCircuits).where(eq(cortexCircuits.id, candidate)).get();
		i++
	) {
		candidate = `${base}-${i}`;
	}
	return candidate;
}

/**
 * Remove an area. Nodes filed under it are left alone and simply become
 * unfiled — deleting a label should never delete what was labelled.
 */
export function deleteCircuit(id: string, userId: string): boolean {
	const circuit = db.select().from(cortexCircuits).where(eq(cortexCircuits.id, id)).get();
	if (!circuit || (circuit.ownerId !== null && circuit.ownerId !== userId)) return false;
	db.delete(cortexCircuits).where(eq(cortexCircuits.id, id)).run();
	for (const node of listNodes(userId)) {
		if (!node.circuits?.includes(id)) continue;
		if (!canEdit(node, userId)) continue;
		db.update(cortexNodes)
			.set({ circuits: node.circuits.filter((c) => c !== id) })
			.where(eq(cortexNodes.id, node.id))
			.run();
	}
	logChange({ userId, event: 'circuit-deleted', detail: circuit.name });
	return true;
}
