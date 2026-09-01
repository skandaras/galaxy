import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { cortexAssociations, cortexNodes, cortexProposals } from '$lib/server/db/schema';
import {
	adjacency,
	circuitIndex,
	cortexSettings,
	deleteAssociation,
	deleteNode,
	erodedEdges,
	findNodeByName,
	getNode,
	listCircuits,
	listNodes,
	logChange,
	seedNodes,
	mergeNodes,
	saveAssociation,
	saveCircuit,
	saveNode,
	syncFts,
	visibleEdges,
	type CortexAssociation,
	type CortexNode
} from '$lib/server/cortex';
import { gatherActivity, listMemoryItems } from './memory';
import {
	DEFAULT_CORTEX_GROOM,
	getSetting,
	setSetting,
	type CortexGroomSettings
} from '$lib/server/settings';
import { getBudgetStatus } from './budget';
import { getTaskConfig, pickModel } from './engine';
import { emitEvent } from './events';
import { extractJson } from './json';
import { logUsage } from './usage';

/**
 * The lattice's gardener.
 *
 * One rule decides everything it does, and it is permanent rather than a
 * cautious phase: **if a change would alter what a query returns, it is
 * proposed, not applied.** Whitespace in a name and an edge pointing at a node
 * that no longer exists are tidying, and go straight through. Merges, weights,
 * new connections, deletions and areas all change retrieval, so they wait for
 * the person whose lattice it is.
 *
 * That line is worth more than a finer-grained risk scale would be. "Low risk"
 * invites argument about where something sits; "does this change an answer" can
 * be settled by looking.
 *
 * It never writes across an ownership boundary — it runs per user, over that
 * person's own lattice.
 */

const LAST_RUN_KEY = 'cortex.groom.lastRun';
const USER_ENABLED_KEY = 'cortex.groom.userEnabled';
const WATERMARK_KEY = 'cortex.groom.watermark';
/**
 * How far back a *first* harvest looks.
 *
 * Without this the watermark starts at 0 and the first pass asks for every
 * conversation ever had — slow enough to hit the request timeout, and the wrong
 * input besides for a job whose entire purpose is what is new. The UX audit
 * guards its watermark the same way; this copied the watermark and not the
 * guard, and the first live run timed out because of it.
 */
const FIRST_RUN_WINDOW_MS = 3 * 86_400_000;
const LATTICE_MARK_KEY = 'cortex.groom.latticeMark';
/**
 * Floor for the retry after a reasoning model burns its budget, so a small
 * configured cap still gets real room on the second attempt. Copied from
 * `research.ts`, which has had exactly this for exactly this reason.
 */
const RETRY_TOKENS_FLOOR = 32_768;

export type GroomMode = 'harvest' | 'review';

export interface GroomResult {
	ran: boolean;
	mode: GroomMode;
	reason?: string;
	tidied?: number;
	detected?: number;
	proposed?: number;
	duplicates?: number;
	/** Suggestions the model made that could not be filed, and why. */
	dropped?: RecordResult['dropped'];
	/** Sizes and flags only, so a caller can tell these apart without any content. */
	replyChars?: number;
	parsedItems?: number;
	/** How much conversation the window returned: read nothing, or read plenty. */
	activityChars?: number;
	windowHours?: number;
	/** Why the model stopped. 'length' with no text is the reasoning failure. */
	finishReason?: string | null;
	/** The model thought until its budget ran out and never began answering. */
	reasonedOnly?: boolean;
	/** How big the prompt was, and where the seconds actually went. */
	promptChars?: number;
	buildMs?: number;
	modelMs?: number;
	/** The first call came back empty on length, so it was asked again with room. */
	retried?: boolean;
}

export function groomSettings(): CortexGroomSettings {
	return {
		...DEFAULT_CORTEX_GROOM,
		...getSetting<Partial<CortexGroomSettings>>('cortexGroom', {})
	};
}

export function groomStatus(userId: string) {
	return {
		lastRun: getSetting<number>(LAST_RUN_KEY, 0, userId),
		// Whether *your* lattice gets groomed is yours; how often the job runs at
		// all is the platform's. The same split the memory job uses.
		enabled: getSetting<boolean>(USER_ENABLED_KEY, true, userId)
	};
}

export function setUserGroomEnabled(userId: string, enabled: boolean): void {
	setSetting(USER_ENABLED_KEY, enabled, userId);
}

/**
 * Stable enough that the same suggestion is recognised on a later run.
 *
 * Sorted for the kinds where the two ends are interchangeable. A merge of A into
 * B and a merge of B into A are the same conversation to have, and a detector
 * finding one while a model proposes the other would otherwise put both in the
 * queue — duplicating precisely where the two halves of the groomer overlap
 * most.
 */
const SYMMETRIC_KINDS = new Set(['merge', 'connect', 'disconnect', 'weight']);

export function fingerprint(kind: string, ...parts: string[]): string {
	const cleaned = parts.map((p) => p.trim().toLowerCase()).filter(Boolean);
	const ordered = SYMMETRIC_KINDS.has(kind) ? [...cleaned].sort() : cleaned;
	return [kind, ...ordered].join('|').slice(0, 300);
}

// --- the mechanical pass ----------------------------------------------------

/**
 * Changes that cannot alter a result, applied without asking.
 *
 * Deterministic and model-free on purpose: this half has to be testable without
 * a provider configured, and it is the half that runs every time whether or not
 * anything is set up.
 */
export function tidy(userId: string, runId: string): number {
	let changed = 0;

	for (const node of listNodes(userId)) {
		if (node.ownerId !== userId && node.ownerId !== null) continue;
		const cleaned = node.name.replace(/\s+/g, ' ').trim();
		if (cleaned === node.name || !cleaned) continue;
		// Whitespace only. Anything that changes the *words* changes what FTS
		// matches, and therefore what a query returns — that is a proposal.
		db.update(cortexNodes)
			.set({ name: cleaned, updatedAt: new Date() })
			.where(eq(cortexNodes.id, node.id))
			.run();
		// Through the store's own helper: the search index has to follow the name,
		// and hand-built SQL here would be a second place for that to drift.
		syncFts(node.id, cleaned, node.description);
		logChange({
			nodeId: node.id,
			actor: 'groom',
			userId,
			event: 'tidied',
			detail: `name whitespace: "${node.name}" → "${cleaned}"`,
			before: node,
			runId
		});
		changed++;
	}

	// There is deliberately no dead-edge sweep here.
	//
	// The first version had one, and it was unreachable code dressed as
	// diligence: `visibleEdges` is bounded by the nodes a reader can see, so an
	// edge whose far end no longer exists is never in the set to begin with.
	// Foreign keys are on and `deleteNode` clears edges first, so such a row can
	// only arrive through an import or a hand-edit — and when it does it is
	// inert, invisible to traversal, the map and the export alike.
	//
	// Cleaning it would take an unscoped query over rows belonging to nobody,
	// and the groomer touching anything it cannot reach through the owner-scoped
	// API is precisely the boundary that must not soften. A wasted row is the
	// cheaper problem.

	return changed;
}

// --- the detectors ----------------------------------------------------------

/**
 * Things a model should never have been asked to find.
 *
 * Orphans, duplicate names and unfiled concepts are graph properties, not
 * language ones. Computing them here costs nothing, runs on every pass whether
 * or not a provider is configured, and leaves the model the only job it is
 * uniquely good at: reading what somebody said and proposing a concept from it.
 *
 * That split is also what makes a daily — or hourly — cadence affordable. The
 * expensive half is the one that needs a model, and it now has much less to do.
 */

/** Words too generic to make two names similar on their own. */
const WEAK = new Set(['the', 'a', 'an', 'and', 'of', 'in', 'to', 'for', 'my', 'our']);

function nameTokens(name: string): Set<string> {
	return new Set(
		name
			.toLowerCase()
			.replace(/[^a-z0-9\s]/g, ' ')
			.split(/\s+/)
			.filter((t) => t.length > 2 && !WEAK.has(t))
			// A crude plural strip rather than real stemming, and worth naming as
			// such. Without it "Tide pools" and "Tide pool surveying" share only
			// one token in four and score 0.25 — well under the threshold — which
			// is precisely the pair a person would call the same concept twice.
			.map((t) => (t.length > 3 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t))
	);
}

/** Jaccard overlap, which is enough to catch what a person would call the same thing twice. */
export function nameSimilarity(a: string, b: string): number {
	const left = nameTokens(a);
	const right = nameTokens(b);
	if (!left.size || !right.size) return 0;
	let shared = 0;
	for (const t of left) if (right.has(t)) shared++;
	return shared / (left.size + right.size - shared);
}

const DUPLICATE_THRESHOLD = 0.6;
/** How many orphans one pass will try to find a neighbour for. */
const MAX_ORPHAN_PAIRINGS = 40;

export interface Detected {
	kind: Kind;
	title: string;
	rationale: string;
	node: string;
	target?: string;
	/** What accepting it should do, in the same shape a model would send. */
	payload?: Record<string, unknown>;
}

/**
 * Concepts nothing connects to, which no query can reach.
 *
 * Exported because the groom prompt lists the ones this pass could not pair up
 * — see `buildGroomPrompt`. A detector that finds a problem it cannot suggest a
 * fix for should hand the problem to the half that can, not file a row saying
 * "something is wrong" that nobody can act on.
 */
export function orphans(userId: string): CortexNode[] {
	const degree = new Map<string, number>();
	for (const e of visibleEdges(userId)) {
		degree.set(e.sourceId, (degree.get(e.sourceId) ?? 0) + 1);
		degree.set(e.targetId, (degree.get(e.targetId) ?? 0) + 1);
	}
	return listNodes(userId)
		.filter((n) => n.ownerId === userId || n.ownerId === null)
		.filter((n) => !degree.get(n.id));
}

export function detect(userId: string): Detected[] {
	const nodes = listNodes(userId).filter((n) => n.ownerId === userId || n.ownerId === null);
	const edges = visibleEdges(userId);
	const linked = new Set(edges.flatMap((e) => [`${e.sourceId} ${e.targetId}`, `${e.targetId} ${e.sourceId}`]));

	const out: Detected[] = [];

	/**
	 * An orphan is only worth filing with something to connect it *to*.
	 *
	 * The first version filed these as a `connect` with a node and no target,
	 * which `applyProposal` cannot carry out — every `connect` needs two ends. So
	 * Accept returned false, the route answered "No such open suggestion", and on
	 * a young lattice, where most concepts are orphans, most of the review queue
	 * was rows that failed with a message implying they were stale. That is the
	 * whole of "it logs what it did and never does anything".
	 *
	 * A candidate comes from the retrieval machinery already here: whatever the
	 * concept's own name and description match best. It is a suggestion about
	 * *text*, and the rationale says so rather than claiming the two mean
	 * something to each other. Where FTS offers nothing, nothing is filed and the
	 * orphan goes to the prompt instead, where a model can do better than a
	 * string match.
	 */
	// Bounded, because each of these is an FTS query plus a scoped read. A lattice
	// that has never been connected is *all* orphans, the queue cannot hold more
	// than this anyway, and the ones left over reach the model through the prompt
	// rather than being lost.
	for (const node of orphans(userId).slice(0, MAX_ORPHAN_PAIRINGS)) {
		const candidate = seedNodes(`${node.name} ${node.description}`, userId, 4).find(
			(n) =>
				n.id !== node.id &&
				!linked.has(`${node.id} ${n.id}`) &&
				// Never the near-duplicate. FTS ranks it first by construction — two
				// names sharing most of their words match each other better than
				// anything else does — and proposing "connect these" beside "these
				// are the same concept" is two suggestions that contradict each
				// other. If they are one thing, the merge is the answer.
				nameSimilarity(node.name, n.name) < DUPLICATE_THRESHOLD
		);
		if (!candidate) continue;
		out.push({
			kind: 'connect',
			title: `"${node.name}" connects to nothing — link it to "${candidate.name}"?`,
			rationale:
				`Traversal can only reach a concept through a connection, so "${node.name}" cannot surface in any query as it stands. ` +
				`"${candidate.name}" is the closest match by name and description, which is a starting point rather than a claim that the two belong together — ` +
				'dismiss it and connect it to something better if this is the wrong neighbour.',
			node: node.id,
			target: candidate.id,
			payload: {
				// Modest on purpose: a connection nobody has vouched for should not
				// arrive as strong as one somebody argued for.
				weight: 0.4,
				why: `Related by name and description; recorded so "${node.name}" is reachable at all.`
			}
		});
	}

	for (let i = 0; i < nodes.length; i++) {
		for (let j = i + 1; j < nodes.length; j++) {
			if (nameSimilarity(nodes[i].name, nodes[j].name) < DUPLICATE_THRESHOLD) continue;
			out.push({
				kind: 'merge',
				title: `"${nodes[i].name}" and "${nodes[j].name}" may be one concept`,
				rationale:
					'Near-identical names split the connections that should have reinforced each other, so each half surfaces more weakly than the whole would.',
				node: nodes[i].id,
				target: nodes[j].id
			});
		}
	}

	/**
	 * Connections that learning has eroded as far as it goes, and that nothing
	 * has traversed in a long time.
	 *
	 * This is the only place erosion is allowed to end in a removal, and it ends
	 * in a *suggestion* to remove. Decay may move a number on its own — that is
	 * what makes it learning rather than bookkeeping — but the thing it can never
	 * do unasked is destroy a relationship somebody recorded.
	 */
	const stale = cortexSettings().staleDays;
	for (const edge of erodedEdges(userId, stale)) {
		const from = nodes.find((n) => n.id === edge.sourceId);
		const to = nodes.find((n) => n.id === edge.targetId);
		if (!from || !to) continue;
		const days = edge.lastTraversedAt
			? Math.round((Date.now() - edge.lastTraversedAt.getTime()) / 86_400_000)
			: null;
		out.push({
			kind: 'disconnect',
			title: `"${from.name}" and "${to.name}" have faded`,
			rationale:
				`This connection has eroded to the floor and ${days === null ? 'no query has ever traversed it' : `nothing has traversed it in ${days} days`}. ` +
				'It still costs a hop in every walk through either concept. Remove it, or dismiss this and it will be left alone.',
			node: edge.sourceId,
			target: edge.targetId
		});
	}

	// No unfiled check here any more.
	//
	// Nothing else can file a concept — see the prompt below — so arriving
	// unfiled is now the normal state rather than a fault, and one proposal per
	// unfiled concept would be fifty complaints saying nothing the model is not
	// already being asked to do. Filing is a job of the groom pass, which sees
	// the area index and can name a specific area.

	return out;
}

/** File what the detectors found, through the same queue and the same dedupe. */
export function recordDetected(userId: string, found: Detected[], max: number) {
	return recordProposals(
		userId,
		found.map((d) => ({
			kind: d.kind,
			title: d.title,
			rationale: d.rationale,
			node: d.node,
			target: d.target,
			payload: d.payload
		})),
		max
	);
}

// --- proposals --------------------------------------------------------------

/**
 * The review queue, with its concept ids resolved to names.
 *
 * Resolved here rather than in the browser because the panel would otherwise
 * need the whole lattice to render one row, and because a suggestion whose
 * concepts have been deleted since should say so rather than showing a slug. A
 * queue you cannot read without translating it is a queue nobody reads.
 */
export function listProposals(userId: string, status: 'open' | 'all' = 'open') {
	const where =
		status === 'open'
			? and(eq(cortexProposals.userId, userId), eq(cortexProposals.status, 'open'))
			: eq(cortexProposals.userId, userId);
	const rows = db
		.select()
		.from(cortexProposals)
		.where(where)
		.orderBy(desc(cortexProposals.createdAt), cortexProposals.id)
		.all();
	if (!rows.length) return [];
	const names = new Map(listNodes(userId).map((n) => [n.id, n.name]));
	const areas = new Map(listCircuits(userId).map((c) => [c.id, c.name]));
	return rows.map((r) => ({
		...r,
		nodeName: r.nodeId ? (names.get(r.nodeId) ?? null) : null,
		targetName: r.targetId ? (names.get(r.targetId) ?? null) : null,
		// What accepting would actually do, in terms a person can check: the
		// concepts a `create` would connect to, and the areas it would file it
		// under, by name. Accepting blind is most of why the queue felt inert.
		preview: previewOf(r, names, areas)
	}));
}

type ProposalRow = typeof cortexProposals.$inferSelect;

/** Plain lines describing the change, for the row in the review queue. */
function previewOf(
	p: ProposalRow,
	names: Map<string, string>,
	areas: Map<string, string>
): string[] {
	const payload = (p.payload ?? {}) as Record<string, unknown>;
	const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
	const named = (id: string | null) => (id ? (names.get(id) ?? `${id} (deleted)`) : null);
	const out: string[] = [];

	if (p.kind === 'create') {
		const description = str(payload.description);
		if (description) out.push(description);
		const filed = Array.isArray(payload.areas)
			? payload.areas.map((a) => areas.get(String(a)) ?? String(a))
			: [];
		if (filed.length) out.push(`Files it under ${filed.join(', ')}.`);
		const links = (Array.isArray(payload.connect) ? payload.connect : [])
			.map((raw) => {
				const link = (raw ?? {}) as Record<string, unknown>;
				const ref = str(link.node);
				if (!ref) return null;
				const to = names.get(ref) ?? ref;
				const why = str(link.why);
				return `${to}${why ? ` — ${why}` : ''}`;
			})
			.filter((l): l is string => !!l);
		out.push(
			links.length
				? `Connects it to: ${links.join('; ')}.`
				: 'Connects it to nothing, so it would not surface in a query.'
		);
		return out;
	}

	const from = named(p.nodeId);
	const to = named(p.targetId);
	const weight = typeof payload.weight === 'number' ? payload.weight.toFixed(2) : null;
	switch (p.kind) {
		case 'merge':
			if (from && to) out.push(`Folds "${to}" into "${from}", moving its connections across.`);
			break;
		case 'connect':
			if (from && to) {
				out.push(`Connects "${from}" to "${to}"${weight ? ` at ${weight}` : ''}.`);
				const why = str(payload.why);
				if (why) out.push(why);
			}
			break;
		case 'disconnect':
			if (from && to) out.push(`Removes the connection between "${from}" and "${to}".`);
			break;
		case 'weight':
			if (from && to) out.push(`Sets "${from}" to "${to}" to ${weight ?? '?'}.`);
			break;
		case 'circuit': {
			const filed = Array.isArray(payload.areas)
				? payload.areas.map((a) => areas.get(String(a)) ?? String(a))
				: [];
			if (from) out.push(`Files "${from}" under ${filed.join(', ') || 'nothing'}.`);
			break;
		}
		case 'convergence':
			if (from) {
				out.push(
					payload.isConvergence === false
						? `Stops treating "${from}" as a bridge between areas.`
						: `Marks "${from}" as a bridge between areas.`
				);
			}
			break;
		case 'rename':
			if (from) out.push(`Renames "${from}" to "${str(payload.name) ?? '?'}".`);
			break;
		case 'delete':
			if (from) out.push(`Deletes "${from}" and every connection to it.`);
			break;
	}
	return out;
}

/**
 * Carry out a suggestion.
 *
 * Accepting used to mean flipping a status flag and nothing else, so the button
 * wrote a row and changed no lattice — worse than having no button, because it
 * looked like it had worked. This is the half that was missing.
 *
 * Every change goes through the ordinary write path under one `runId`, so an
 * accepted suggestion is logged like any hand edit and undone the same way. A
 * proposal whose concepts have been deleted since it was raised fails and stays
 * open rather than half-applying.
 */
/**
 * Turn whatever the model called an area into an id that exists.
 *
 * It is given ids and asked to prefer them, but it is a model: it will
 * sometimes answer with the display name, and occasionally with a name for an
 * area that should exist and does not. An id matches first, then a name, and
 * only then is one created — which is allowed here because a person read this
 * proposal before it ran, and is the reason `cortex_write` cannot do the same.
 */
function resolveAreas(userId: string, raw: unknown): string[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const known = listCircuits(userId);
	const out: string[] = [];
	for (const entry of raw) {
		const wanted = String(entry ?? '').trim();
		if (!wanted) continue;
		const match =
			known.find((c) => c.id === wanted) ??
			known.find((c) => c.name.toLowerCase() === wanted.toLowerCase());
		if (match) {
			out.push(match.id);
			continue;
		}
		try {
			const made = saveCircuit({ name: wanted, ownerId: userId });
			known.push(made);
			out.push(made.id);
		} catch {
			// An area belonging to somebody else. Skip it rather than fail the
			// whole proposal over a label.
		}
	}
	return out.length ? out : undefined;
}

/**
 * What came of trying to carry a suggestion out.
 *
 * A boolean was not enough. Every refusal in here came back as `false`, the
 * route turned that into `404 "No such open suggestion"`, and a person who had
 * just watched a row fail was told the row did not exist. Saying which of half a
 * dozen things went wrong is the difference between a queue you trust and one
 * you stop reading.
 */
export interface ApplyResult {
	ok: boolean;
	reason?: string;
}

export function applyProposal(id: string, userId: string): ApplyResult {
	const p = db
		.select()
		.from(cortexProposals)
		.where(
			and(
				eq(cortexProposals.id, id),
				eq(cortexProposals.userId, userId),
				eq(cortexProposals.status, 'open')
			)
		)
		.get();
	if (!p) return { ok: false, reason: 'missing' };

	const runId = randomUUID();
	const payload = (p.payload ?? {}) as Record<string, unknown>;
	const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
	const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

	/**
	 * Which concepts this suggestion is about.
	 *
	 * The columns, or — where they are empty — whatever the payload still holds.
	 * `recordProposals` now reads both places, so nothing filed after this change
	 * needs the fallback; what needs it is every row filed *before* it, which
	 * sits in somebody's queue with a null `nodeId` and the reference the model
	 * sent stored one level down. Recovering it is exact rather than a guess: it
	 * is the model's own value, in the wrong envelope.
	 */
	const refFrom = (key: string): string | null => {
		const raw = str(payload[key]);
		if (!raw) return null;
		return (getNode(raw, userId) ?? findNodeByName(raw, userId))?.id ?? null;
	};
	const nodeId = p.nodeId ?? refFrom('node');
	const targetId = p.targetId ?? refFrom('target');
	/** Said once: a row from before the queue enforced its own shape. */
	const unnamed = {
		ok: false as const,
		reason:
			'this suggestion never named which concept it is about — dismiss it, and the next pass will raise it properly'
	};

	try {
		switch (p.kind) {
			case 'create': {
				const name = str(payload.name) ?? p.title;
				const node = saveNode({
					name,
					description: str(payload.description),
					// Filing happens here and only here: this proposal was read by a
					// person, which is what the tool path cannot claim.
					circuits: resolveAreas(userId, payload.areas),
					ownerId: userId,
					actor: 'groom',
					runId
				});
				// A concept with no connections can never surface in a query, so the
				// links are part of the suggestion rather than a follow-up.
				for (const raw of Array.isArray(payload.connect) ? payload.connect : []) {
					const link = (raw ?? {}) as Record<string, unknown>;
					const targetRef = str(link.node);
					if (!targetRef) continue;
					const target = getNode(targetRef, userId) ?? findNodeByName(targetRef, userId);
					if (!target || target.id === node.id) continue;
					saveAssociation({
						sourceId: node.id,
						targetId: target.id,
						weight: num(link.weight),
						description: str(link.why),
						userId,
						actor: 'groom',
						runId
					});
				}
				break;
			}
			case 'merge': {
				if (!nodeId || !targetId) {
					return { ok: false, reason: 'that suggestion does not name two concepts to merge' };
				}
				if (!mergeNodes(nodeId, targetId, userId, 'groom')) {
					return { ok: false, reason: 'one of those concepts is gone, or is not yours to merge' };
				}
				break;
			}
			case 'connect': {
				if (!nodeId || !targetId) {
					return { ok: false, reason: 'that suggestion does not name what to connect it to' };
				}
				saveAssociation({
					sourceId: nodeId,
					targetId,
					weight: num(payload.weight),
					description: str(payload.why),
					userId,
					actor: 'groom',
					runId
				});
				break;
			}
			case 'disconnect': {
				if (!nodeId || !targetId) {
					return { ok: false, reason: 'that suggestion does not name a connection' };
				}
				// Either orientation: a symmetric connection is stored once, and which
				// way round is an implementation detail the suggestion did not choose.
				if (
					!deleteAssociation(nodeId, targetId, userId, 'groom') &&
					!deleteAssociation(targetId, nodeId, userId, 'groom')
				) {
					return { ok: false, reason: 'that connection is already gone' };
				}
				break;
			}
			case 'weight': {
				if (!nodeId || !targetId || num(payload.weight) === undefined) {
					return { ok: false, reason: 'that suggestion does not name a connection and a strength' };
				}
				saveAssociation({
					sourceId: nodeId,
					targetId,
					weight: num(payload.weight),
					userId,
					actor: 'groom',
					runId
				});
				break;
			}
			case 'circuit':
			case 'convergence':
			case 'rename': {
				if (!nodeId) return unnamed;
				const node = getNode(nodeId, userId);
				if (!node) return { ok: false, reason: 'that concept has been deleted since' };
				// Two silent no-ops, said out loud. Without the new name a rename
				// saves the concept under the name it already has; without the areas
				// a filing keeps the ones it already had. Both then report success
				// and mark the suggestion done, which is the failure this whole queue
				// was rebuilt to stop — a button that looks like it worked.
				if (p.kind === 'rename' && !str(payload.name)) {
					return { ok: false, reason: 'that suggestion does not say what to rename it to' };
				}
				if (p.kind === 'circuit' && !Array.isArray(payload.areas)) {
					return { ok: false, reason: 'that suggestion does not name an area to file it under' };
				}
				saveNode({
					id: node.id,
					name: p.kind === 'rename' ? (str(payload.name) ?? node.name) : node.name,
					ownerId: userId,
					circuits: resolveAreas(userId, payload.areas),
					isConvergence:
						p.kind === 'convergence' ? payload.isConvergence !== false : undefined,
					actor: 'groom',
					runId
				});
				break;
			}
			case 'delete': {
				if (!nodeId) return unnamed;
				if (!deleteNode(nodeId, userId, 'groom')) {
					return { ok: false, reason: 'that concept is gone, or is not yours to delete' };
				}
				break;
			}
			default:
				return { ok: false, reason: `nothing here knows how to apply a "${p.kind}" suggestion` };
		}
	} catch (err) {
		// A concept gone since the suggestion was raised, or the cap reached.
		// Leave it open: a half-applied change nobody was told about is worse
		// than one that plainly did not happen. The store's own message is the
		// useful one — it is the half that knows which rule was hit.
		return { ok: false, reason: err instanceof Error ? err.message : 'could not apply that' };
	}

	db.update(cortexProposals)
		.set({ status: 'actioned', decidedAt: new Date() })
		.where(eq(cortexProposals.id, id))
		.run();
	return { ok: true };
}

export function decideProposal(
	id: string,
	userId: string,
	status: 'actioned' | 'discarded'
): ApplyResult {
	// Accepting means doing the thing. Only a dismissal is a bare status change.
	if (status === 'actioned') return applyProposal(id, userId);
	const res = db
		.update(cortexProposals)
		.set({ status, decidedAt: new Date() })
		.where(
			and(
				eq(cortexProposals.id, id),
				eq(cortexProposals.userId, userId),
				eq(cortexProposals.status, 'open')
			)
		)
		.run();
	return res.changes > 0 ? { ok: true } : { ok: false, reason: 'missing' };
}

/**
 * File this run's suggestions, dropping anything already decided.
 *
 * The fingerprint check spans every status, not just open ones: something
 * accepted is done, and something turned down was considered and declined.
 * Re-raising either is how a review queue teaches people to stop reading it.
 */
export interface RecordResult {
	added: number;
	duplicates: number;
	/**
	 * What was thrown away, and why.
	 *
	 * Counted rather than silently dropped, because "the model suggested nothing"
	 * and "the model suggested six things and every one named a concept that does
	 * not exist" are different problems with the same old readout, and only one
	 * of them is fixed by trying again.
	 */
	dropped: {
		unknownConcept: number;
		badKind: number;
		noTitle: number;
		/** Named no concept, or left out a field without which it is a no-op. */
		incomplete: number;
	};
}

export function recordProposals(userId: string, raw: unknown[], max: number): RecordResult {
	const known = new Set(
		db
			.select({ fingerprint: cortexProposals.fingerprint })
			.from(cortexProposals)
			.where(eq(cortexProposals.userId, userId))
			.all()
			.map((r) => r.fingerprint)
	);
	const nodes = listNodes(userId);
	const visible = new Set(nodes.map((n) => n.id));
	/**
	 * Ids are what the prompt asks for; names are what a model sometimes sends.
	 *
	 * The first version dropped anything that was not already an id, so a
	 * perfectly good "merge Tide pools into Rockpools" vanished without a word
	 * for naming the concepts the way a person would. Resolving here costs
	 * nothing and is the same courtesy `resolveAreas` already extends to areas.
	 */
	const resolve = (ref: string | null): string | null => {
		if (!ref) return null;
		if (visible.has(ref)) return ref;
		return findNodeByName(ref, userId)?.id ?? null;
	};

	let added = 0;
	let duplicates = 0;
	const dropped = { unknownConcept: 0, badKind: 0, noTitle: 0, incomplete: 0 };

	for (const item of raw.slice(0, max)) {
		const p = (item ?? {}) as Record<string, unknown>;
		const kind = String(p.kind ?? '');
		const title = String(p.title ?? '').trim();
		if (!KINDS.includes(kind as Kind)) {
			dropped.badKind++;
			continue;
		}
		if (!title) {
			dropped.noTitle++;
			continue;
		}

		// Top level is where the prompt asks for these, and where they usually
		// are. Inside `payload` is where they land when a model reads
		// `circuit — "node", payload {…}` as one nesting rather than two, which
		// is a fair misreading and not worth losing a good suggestion over — it
		// answered the question correctly, in the wrong envelope.
		const payload = (p.payload ?? {}) as Record<string, unknown>;
		const ref = (key: string): string | null => {
			const top = p[key];
			if (typeof top === 'string' && top.trim()) return top.trim();
			const nested = payload[key];
			return typeof nested === 'string' && nested.trim() ? nested.trim() : null;
		};
		const nodeRef = ref('node');
		const targetRef = ref('target');
		// A proposal naming a node this person cannot see is either a model
		// hallucination or a boundary crossing. Neither is worth filing.
		// `create` is the exception by definition: its concept does not exist yet.
		let nodeId = nodeRef;
		let targetId = targetRef;
		if (kind !== 'create') {
			nodeId = resolve(nodeRef);
			targetId = resolve(targetRef);
			if ((nodeRef && !nodeId) || (targetRef && !targetId)) {
				dropped.unknownConcept++;
				continue;
			}
		}

		// The rule this table exists for: nothing reaches the queue that the
		// apply path could not carry out. A row that fails on click is worse than
		// no row, because it costs somebody the click and reads as a broken
		// button rather than a suggestion the model got wrong.
		const needs = REQUIRES[kind as Kind];
		const complete =
			(!needs.node || !!nodeId) &&
			(!needs.target || !!targetId) &&
			// The payload as it will actually be stored — the whole item when the
			// model put its detail at the top level rather than under `payload`.
			needs.payload.every((key) => hasField((p.payload ?? p) as Record<string, unknown>, key));
		if (!complete) {
			dropped.incomplete++;
			continue;
		}

		const fp = fingerprint(kind, nodeId ?? title, targetId ?? '');
		if (known.has(fp)) {
			duplicates++;
			continue;
		}
		known.add(fp);
		db.insert(cortexProposals)
			.values({
				id: randomUUID(),
				userId,
				kind: kind as Kind,
				title: title.slice(0, 200),
				rationale: String(p.rationale ?? '').slice(0, 2000),
				nodeId,
				targetId,
				// A model told to put its detail under `payload` mostly does, and
				// sometimes puts the fields at the top level instead. Falling back to
				// the item means a stray `{"kind":"weight","weight":0.8}` is applied
				// rather than filed as a suggestion with nothing in it.
				payload: (p.payload ?? p) as unknown,
				fingerprint: fp,
				status: 'open',
				createdAt: new Date()
			})
			.run();
		added++;
	}
	return { added, duplicates, dropped };
}

export const KINDS = [
	'create',
	'merge',
	'connect',
	'disconnect',
	'weight',
	'circuit',
	'convergence',
	'rename',
	'delete'
] as const;
type Kind = (typeof KINDS)[number];

/**
 * What each kind needs before it can be carried out.
 *
 * **The queue must never hold a row that cannot be applied.** This table is
 * where that rule lives, because until it existed the rule lived nowhere:
 * `recordProposals` decided what to file and `applyProposal` decided what it
 * could do, they disagreed, and every disagreement surfaced as a button that
 * did nothing. Twice, in two different kinds, found weeks apart — an orphan
 * `connect` filed with only one end, then a `circuit` filed with no concept at
 * all.
 *
 * `payload` names the fields without which the change would be a *silent*
 * no-op, which is the worse failure: a `rename` with no new name saves the
 * concept under the name it already has, reports success, and marks the
 * suggestion done. Requiring the field up front is what stops that.
 *
 * `create` needs nothing: its concept does not exist yet, and its name falls
 * back to the title.
 */
export const REQUIRES: Record<Kind, { node: boolean; target: boolean; payload: string[] }> = {
	create: { node: false, target: false, payload: [] },
	merge: { node: true, target: true, payload: [] },
	connect: { node: true, target: true, payload: [] },
	disconnect: { node: true, target: true, payload: [] },
	weight: { node: true, target: true, payload: ['weight'] },
	circuit: { node: true, target: false, payload: ['areas'] },
	convergence: { node: true, target: false, payload: [] },
	rename: { node: true, target: false, payload: ['name'] },
	delete: { node: true, target: false, payload: [] }
};

/** Whether a payload carries a usable value under this key. */
function hasField(payload: Record<string, unknown>, key: string): boolean {
	const value = payload[key];
	if (typeof value === 'string') return value.trim().length > 0;
	if (typeof value === 'number') return Number.isFinite(value);
	if (Array.isArray(value)) return value.length > 0;
	return value !== undefined && value !== null;
}

// --- the prompt -------------------------------------------------------------

/**
 * One concept in full: what it is, and what it reaches.
 *
 * Takes the adjacency map rather than looking its own connections up. The
 * lookup costs a full node select plus a full edge select, and this runs once
 * per concept — so a fifty-concept review spent about a hundred and fifty
 * full-table reads assembling one string, and it grew as the square of the
 * lattice.
 */
function describeNode(node: CortexNode, links: Map<string, CortexAssociation[]>): string {
	const to = (links.get(node.id) ?? [])
		.map((e) => (e.sourceId === node.id ? e.targetId : e.sourceId))
		.join(', ');
	return `- ${node.id} "${node.name}"${node.isConvergence ? ' [bridge]' : ''} — ${node.description || '(no description)'}${to ? `\n    connects to: ${to}` : '\n    connects to: nothing'}`;
}

/** A concept the model only needs to know exists, so it does not propose it again. */
const nameOnly = (n: CortexNode) => `- ${n.id} "${n.name}"`;

/**
 * A handful of words that stand for the whole window.
 *
 * `seedNodes` decides which concepts a harvest sees in full, and `ftsQuery`
 * keeps only the first eight usable terms of whatever it is handed. Handed the
 * raw activity, those eight came from the opening line of the newest chat — so
 * on a five-thousand-character read, the slice of the lattice shown in full was
 * chosen by how one conversation happened to start.
 *
 * Sampling across the window instead: a word from every few hundred characters,
 * so the terms come from the whole of what was said rather than the top of it.
 * Crude, and enough — this only has to land in the right neighbourhood, and the
 * eight-term cap means anything cleverer is thrown away anyway.
 */
export function activityGist(activity: string, stride = 400): string {
	const words = activity.split(/\s+/).filter((w) => w.length > 3 && /[a-z]/i.test(w));
	if (words.length < 40) return activity;
	const out: string[] = [];
	// Spread the picks evenly rather than taking a prefix, which is the whole
	// point; `ftsQuery` will drop stopwords and keep the first eight survivors.
	const step = Math.max(1, Math.floor(activity.length / stride / 8) || 1);
	for (let i = 0; i < words.length && out.length < 40; i += Math.max(step, 1)) out.push(words[i]);
	return out.join(' ');
}

/**
 * How much of the prompt the concept descriptions may take.
 *
 * A review used to send every concept with its description and its connections,
 * on the argument that merges cannot be judged from a slice. True, and it stops
 * being affordable well before the lattice stops being useful — the prompt grows
 * with the lattice and the model's patience does not.
 *
 * So the budget buys full detail for the concepts most worth judging, and every
 * other concept still appears by name. Nothing is invisible; what is rationed is
 * description and connection lists.
 */
const LATTICE_BUDGET_CHARS = 24_000;

/**
 * Which concepts earn their full description first.
 *
 * Most connected leads, because a merge, a bridge and a cluster with no way out
 * are all judged from connections, and a concept with none of them can be judged
 * from its name. Unfiled next, since filing is a job only this pass can do, then
 * most recently touched, because that is where a person has been working.
 */
function judgingOrder(nodes: CortexNode[], links: Map<string, CortexAssociation[]>): CortexNode[] {
	return [...nodes].sort((a, b) => {
		const degree = (links.get(b.id)?.length ?? 0) - (links.get(a.id)?.length ?? 0);
		if (degree) return degree;
		const filed = Number(!a.circuits?.length) - Number(!b.circuits?.length);
		if (filed) return -filed;
		return (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0);
	});
}

/**
 * What the model is shown, and it depends on which job this is.
 *
 * **Harvest** — the scheduled pass, about *adding*. It sees what has been said
 * since the last run, plus enough of the lattice to avoid proposing something
 * already there: full detail for the concepts `seedNodes` says bear on the new
 * activity, and bare names for the rest. Reusing the retrieval machinery to
 * pick that slice beats inventing a second notion of relevance.
 *
 * **Review** — the manual pass, about *consolidating*. It sees everything, with
 * connections, because merges and structural problems cannot be judged from a
 * slice. That is the expensive prompt, and it only ever runs because a person
 * asked for it.
 */
export function buildGroomPrompt(
	userId: string,
	max: number,
	mode: GroomMode = 'review',
	activity = ''
): string {
	const nodes = listNodes(userId);
	const { circuits, unfiled } = circuitIndex(userId);
	const decided = db
		.select({ title: cortexProposals.title, status: cortexProposals.status })
		.from(cortexProposals)
		.where(eq(cortexProposals.userId, userId))
		.all()
		.map((p) => `- [${p.status}] ${p.title}`)
		.slice(0, 200);

	// Capped: on a large lattice this is the one unbounded list in the prompt,
	// and a hundred unfiled concepts would crowd out everything else.
	const unfiledNodes = nodes.filter((n) => !n.circuits?.length).slice(0, 30);
	// Capped for the same reason: on a lattice that has never been connected this
	// is every concept, and it would crowd out the activity the pass is here for.
	const stranded = orphans(userId).slice(0, 30);
	// Once, for every concept below, rather than once per concept.
	const links = adjacency(userId);

	/**
	 * Which concepts get a full description, and which only a name.
	 *
	 * The two modes ration for different reasons, and both reasons are real.
	 *
	 * A **harvest** rations by *relevance*: only what the new conversation
	 * actually touches is worth describing, however much room there is. That is
	 * a judgement about usefulness, so it holds on a small lattice too.
	 *
	 * A **review** rations by *cost*: every concept deserves detail in principle
	 * — merges and structure are judged from connections — but the prompt cannot
	 * grow with the lattice for ever. Most connected first, since a merge, a
	 * bridge and a cluster with no way out are all read off connections.
	 *
	 * The budget then applies to both as a ceiling. Either way every concept is
	 * still named, so nothing is proposed twice.
	 */
	const candidates =
		mode === 'harvest'
			? (() => {
					const relevant = new Set(seedNodes(activityGist(activity), userId, 25).map((n) => n.id));
					return nodes.filter((n) => relevant.has(n.id));
				})()
			: judgingOrder(nodes, links);
	const rest = new Set(nodes.filter((n) => !candidates.includes(n)));

	const inFull: CortexNode[] = [];
	const byName: CortexNode[] = [...rest];
	let spent = 0;
	for (const node of candidates) {
		const described = describeNode(node, links);
		// `inFull.length` guards the degenerate case: one concept whose
		// description alone exceeds the budget still gets described, or a harvest
		// could come back with no detail at all.
		if (spent + described.length > LATTICE_BUDGET_CHARS && inFull.length) {
			byName.push(node);
			continue;
		}
		spent += described.length;
		inFull.push(node);
	}
	// Listed in the lattice's own order, not the budget's: the model is reading
	// this to hold a shape in mind, and a list sorted by how it was rationed is
	// a harder shape to hold.
	const named = (list: CortexNode[]) => nodes.filter((n) => list.includes(n));
	const lattice = byName.length
		? [
				named(inFull).map((n) => describeNode(n, links)).join('\n'),
				`--- EVERY OTHER CONCEPT (${byName.length}; names only, so you do not propose one that exists) ---`,
				named(byName).map(nameOnly).join('\n')
			].join('\n\n')
		: named(inFull).map((n) => describeNode(n, links)).join('\n');

	const task =
		mode === 'harvest'
			? [
					`Propose at most ${max} concepts worth adding, based on what was said.`,
					'A concept is a thing facts can be about, not a fact — "prefers dark themes" is an observation, "visual design" is a concept. Propose one only when it would help answer a later question about this person, and give each the connections that make it reachable.',
					'Nothing worth adding is a fine answer. Reply with an empty list.',
					'Also file anything under NOT YET FILED: nothing else can put a concept in an area, so those are waiting on you. Use an existing area wherever one fits — the index is what every agent navigates by, so it is worth keeping small — and only name a new one when nothing does.'
				].join(' ')
			: [
					`Suggest at most ${max} changes that would make this lattice better at answering questions about its owner.`,
					'Look for: near-duplicate concepts that should be merged; clusters with no connection leaving them, which add nothing plain search would not already find; obvious missing connections between concepts that clearly relate; concepts bridging several areas that are not marked as bridges.',
					'Also file anything under NOT YET FILED: nothing else can put a concept in an area. Prefer an existing area — the index is what every agent navigates by, so it is worth keeping small.',
					'Orphans and duplicate names are already found without you — do not spend suggestions on them unless you can say something the check could not.'
				].join(' ');

	return [
		mode === 'harvest'
			? `--- WHAT HAS HAPPENED SINCE THE LAST PASS ---\n${activity || '(nothing new)'}`
			: '--- A FULL REVIEW OF THE LATTICE ---',
		`--- THE LATTICE (${nodes.length} concepts) ---`,
		lattice,
		`--- AREAS ---`,
		circuits.map((c) => `- ${c.id} "${c.name}" (${c.count})`).join('\n') || '(none defined)',
		// Listed rather than counted. Nothing else can file a concept, so these
		// are waiting on this pass — and a count tells a model there is work
		// without telling it what the work is.
		unfiledNodes.length
			? `--- NOT YET FILED (${unfiled}) — propose an area for these ---\n` +
				unfiledNodes.map((n) => `- ${n.id} "${n.name}" — ${n.description || '(no description)'}`).join('\n')
			: 'every concept is filed',
		// The free check pairs an orphan with whatever matches its text, which is
		// a string match and knows it. These are the ones it could not pair at
		// all, handed over because reading two descriptions and seeing that they
		// belong together is the one thing a model is better at than the check.
		stranded.length
			? `--- CONNECTS TO NOTHING (${stranded.length}) — no query can reach these; propose connections ---\n` +
				stranded.map((n) => `- ${n.id} "${n.name}" — ${n.description || '(no description)'}`).join('\n')
			: 'every concept is reachable',
		// Read-only, and one-directional: the groomer may notice that a recorded
		// observation implies a concept, and never writes back to memory.
		`--- RECORDED OBSERVATIONS (never edit these) ---`,
		listMemoryItems(userId)
			.filter((m) => m.status === 'active')
			.slice(0, 60)
			.map((m) => `- (${m.kind}) ${m.content}`)
			.join('\n') || '(none)',
		`--- ALREADY DECIDED (do not raise again) ---`,
		decided.join('\n') || '(nothing yet)',
		`--- YOUR TASK ---`,
		task,
		'Reply with ONLY a JSON object: {"proposals":[…]}. Every item has "kind", "title" (one line) and "rationale" (why), plus whatever its kind needs below.',
		// Whole objects rather than a shorthand. The shorthand read
		// `circuit — "node", payload {"areas":[…]}`, which compresses two nesting
		// levels into one comma: a model read it as "circuit takes a node and a
		// payload" and put the node *inside* the payload. The suggestion was
		// right and unusable, and there was no way to tell from the row.
		'"node" and "target" are always top-level keys, beside "kind" and "title" — never inside "payload". Copy the shape of these exactly:',
		[
			'create — the concept does not exist yet, so it has no "node":\n{"kind":"create","title":"…","rationale":"…","payload":{"name":"…","description":"…","areas":["area-id or a new area name"],"connect":[{"node":"node-id","weight":0.7,"why":"…"}]}}\nConnections are part of the suggestion, not a follow-up: a concept nothing links to can never surface in a query.',
			'merge — "node" is the one to keep, "target" the one folded into it:\n{"kind":"merge","title":"…","rationale":"…","node":"node-id","target":"node-id"}',
			'connect:\n{"kind":"connect","title":"…","rationale":"…","node":"node-id","target":"node-id","payload":{"weight":0.7,"why":"…"}}',
			'disconnect:\n{"kind":"disconnect","title":"…","rationale":"…","node":"node-id","target":"node-id"}',
			'weight — the strength is required, or there is no change to make:\n{"kind":"weight","title":"…","rationale":"…","node":"node-id","target":"node-id","payload":{"weight":0.7}}',
			'circuit — "areas" is the full set the concept should be in, and is required:\n{"kind":"circuit","title":"…","rationale":"…","node":"node-id","payload":{"areas":["area-id"]}}',
			'convergence:\n{"kind":"convergence","title":"…","rationale":"…","node":"node-id","payload":{"isConvergence":true}}',
			'rename — the new name is required:\n{"kind":"rename","title":"…","rationale":"…","node":"node-id","payload":{"name":"…"}}',
			'delete:\n{"kind":"delete","title":"…","rationale":"…","node":"node-id"}'
		].join('\n\n'),
		'Use the exact ids given above; a node id you invent will be dropped, and so will a suggestion missing anything its kind requires. Propose nothing you cannot justify from what you were shown.'
	].join('\n\n');
}

// --- the run ----------------------------------------------------------------

export async function runCortexGroom(
	trigger: 'schedule' | 'manual',
	userId: string,
	/**
	 * The scheduled pass *adds*; a manual one *consolidates*. Two different jobs
	 * that wanted different cadences and different prompts, run as one until it
	 * became clear the expensive half only earns its cost when somebody asks.
	 */
	mode: GroomMode = trigger === 'manual' ? 'review' : 'harvest'
): Promise<GroomResult> {
	const cfg = groomSettings();
	const runId = randomUUID();
	const max = Math.max(1, Math.min(cfg.maxProposalsPerRun, 25));

	// Free, and so unconditional: tidying and the detectors run on every pass
	// whether or not a model is configured, and whichever job this is.
	const tidied = tidy(userId, runId);
	// Uncapped, unlike the model's half. These are graph facts rather than
	// opinions, they cost nothing to find, and capping them meant a lattice with
	// thirty orphans filed the same first ten every run and never got to the
	// rest. The per-run cap is there to stop a model burying the queue.
	const detected = recordDetected(userId, detect(userId), Math.max(max, 50)).added;
	setSetting(LAST_RUN_KEY, Date.now(), userId);

	const nodes = listNodes(userId);
	const watermark =
		getSetting<number>(WATERMARK_KEY, 0, userId) || Date.now() - FIRST_RUN_WINDOW_MS;
	const activity = mode === 'harvest' ? gatherActivity(userId, watermark).text : '';
	// Counts plus the newest edit: enough to notice a concept added, removed or
	// rewritten since the last pass.
	const latticeMark = `${nodes.length}:${visibleEdges(userId).length}:${nodes.reduce(
		(m, n) => Math.max(m, n.updatedAt?.getTime() ?? 0),
		0
	)}`;

	// A harvest reads conversation. With none there is nothing to harvest from,
	// whatever the lattice has been doing — the two conditions used to be ANDed,
	// so on a first run (no stored signature) a pass with nothing to read still
	// spent a model call and got an empty answer back, which is a correct answer
	// to an empty question and a waste of a request.
	if (mode === 'harvest' && !activity.trim()) {
		return {
			ran: false,
			mode,
			reason: 'no new conversation in the window',
			tidied,
			detected,
			activityChars: 0,
			windowHours: Math.round((Date.now() - watermark) / 3_600_000)
		};
	}
	if (
		mode === 'review' &&
		// Only the scheduler is allowed to skip on this. The signature is a cost
		// control on a pass nobody asked for; a person who pressed the button has
		// already decided the expensive prompt is worth running, and telling them
		// "nothing has changed since the last review" is how the button came to
		// look broken — reject everything in the queue and it says that forever.
		trigger === 'schedule' &&
		getSetting<string>(LATTICE_MARK_KEY, '', userId) === latticeMark
	) {
		return { ran: false, mode, reason: 'nothing has changed since the last review', tidied, detected };
	}

	if (getBudgetStatus().blocked) {
		emitEvent({
			task: 'cortex-groom',
			userId,
			type: 'job',
			name: 'cortex.groom',
			status: 'error',
			detail: { trigger, mode, tidied, detected, skipped: true, reason: 'budget cap reached' }
		});
		return { ran: false, mode, reason: 'budget cap reached', tidied, detected };
	}

	const taskCfg = getTaskConfig('cortex-groom');
	const choice = pickModel(taskCfg?.primaryModelId ?? null);
	if (!choice) {
		emitEvent({
			task: 'cortex-groom',
			userId,
			type: 'job',
			name: 'cortex.groom',
			status: 'error',
			detail: { trigger, mode, tidied, detected, reason: 'no model configured' }
		});
		return { ran: false, mode, reason: 'no model configured', tidied, detected };
	}

	if (mode === 'review' && nodes.length < 3) {
		return { ran: false, mode, reason: 'too few concepts to review', tidied, detected };
	}

	const startedAt = Date.now();
	try {
		const builtAt = Date.now();
		const prompt = buildGroomPrompt(userId, max, mode, activity);
		const buildMs = Date.now() - builtAt;

		const ask = (maxTokens: number) =>
			choice.adapter.complete(
				{
					modelKey: choice.model.modelKey,
					messages: [
						{ role: 'system', content: taskCfg?.systemPrompt ?? '' },
						{ role: 'user', content: prompt }
					],
					maxTokens
				},
				AbortSignal.timeout(cfg.timeoutSeconds * 1000)
			);

		const askedAt = Date.now();
		let { text, usage, finishReason, reasonedOnly } = await ask(cfg.maxTokens);

		/**
		 * A reasoning model can spend the whole budget thinking and return no
		 * answer at all. That is what a 52-concept lattice did on 4,860 characters
		 * of conversation: `finishReason: "length"`, `reasonedOnly: true`, nothing
		 * written. The run detected it, reported it, and stopped — and told the
		 * person to raise a Max tokens field that does not exist.
		 *
		 * So it retries once with real headroom, the same rule and the same gate
		 * `research.ts` has used for this since it shipped: nothing came back
		 * *and* it hit the wall. A model that simply had nothing to suggest
		 * returns an empty list and never triggers this, so the common path pays
		 * nothing.
		 */
		let retried = false;
		if (!text.trim() && (reasonedOnly === true || finishReason === 'length')) {
			retried = true;
			({ text, usage, finishReason, reasonedOnly } = await ask(
				Math.max(cfg.maxTokens * 4, RETRY_TOKENS_FLOOR)
			));
		}
		const modelMs = Date.now() - askedAt;
		logUsage('cortex-groom', choice.model.modelKey, usage, 'ok', userId);

		// `.proposals`, not the parsed value itself: extractJson returns an object
		// by construction, so a prompt asking for a bare array gets nothing back
		// however well the model complied. See json.ts.
		const parsed = extractJson(text);
		const proposals = Array.isArray(parsed?.proposals) ? parsed.proposals : [];
		const { added, duplicates, dropped } = recordProposals(userId, proposals, max);
		// Sizes, not content — the rule that no concept text reaches an event
		// detail still holds. Enough to tell a model that said nothing from one
		// that said plenty and had none of it parsed, which is the ambiguity
		// behind "it ran but there was no output".
		const shape = {
			replyChars: text.length,
			parsedItems: proposals.length,
			activityChars: activity.length,
			windowHours: Math.round((Date.now() - watermark) / 3_600_000),
			finishReason: finishReason ?? null,
			// The failure research.ts already names: chain-of-thought on its own
			// channel, no answer text, and indistinguishable from silence without
			// this flag.
			reasonedOnly: reasonedOnly === true,
			// What the run cost, so "it grinds" is a number rather than a report.
			// Answering that question the first time meant reading the source to
			// find out where the seconds could even go. Sizes and timings only; no
			// concept text reaches an event detail.
			promptChars: prompt.length,
			buildMs,
			modelMs,
			retried
		};

		// Only advance the watermark on a pass that actually read the activity,
		// or a failed run would silently skip a day's conversation.
		if (mode === 'harvest') setSetting(WATERMARK_KEY, startedAt, userId);
		setSetting(LATTICE_MARK_KEY, latticeMark, userId);

		emitEvent({
			task: 'cortex-groom',
			userId,
			type: 'job',
			name: 'cortex.groom',
			status: 'ok',
			durationMs: Date.now() - startedAt,
			// Counts only. Concept names never reach an event detail.
			detail: {
				trigger,
				mode,
				tidied,
				detected,
				proposed: added,
				duplicates,
				dropped,
				concepts: nodes.length,
				...shape
			}
		});
		return { ran: true, mode, tidied, detected, proposed: added, duplicates, dropped, ...shape };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		// `AbortSignal.timeout` throws a TimeoutError; some runtimes only say so
		// in the message. Both readings, because naming a timeout as one is the
		// difference between "raise the limit" and "something is broken".
		const timedOut =
			(err instanceof Error && err.name === 'TimeoutError') || /timeout|aborted/i.test(message);
		emitEvent({
			task: 'cortex-groom',
			userId,
			type: 'job',
			name: 'cortex.groom',
			status: 'error',
			durationMs: Date.now() - startedAt,
			detail: { trigger, mode, tidied, detected, error: message }
		});
		// The provider's own words, not "model call failed".
		//
		// Every failure used to come back as that one phrase, so the actual
		// message — "The operation was aborted due to timeout" — existed only in
		// the Observatory and had to be dug out by hand to find out what had gone
		// wrong. The panel is where somebody looks first; it should not be the
		// least informative place in the system.
		return {
			ran: false,
			mode,
			reason: timedOut
				? `the model did not answer within ${cfg.timeoutSeconds}s — raise the time limit in Admin → Cortex, or use a faster model`
				: message,
			tidied,
			detected
		};
	}
}
