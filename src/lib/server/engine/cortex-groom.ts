import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { cortexAssociations, cortexNodes, cortexProposals } from '$lib/server/db/schema';
import {
	circuitIndex,
	cortexSettings,
	deleteAssociation,
	deleteNode,
	erodedEdges,
	findNodeByName,
	getNode,
	listAssociations,
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
	dropped?: { unknownConcept: number; badKind: number; noTitle: number };
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
	for (const node of orphans(userId)) {
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
				if (!p.nodeId || !p.targetId) {
					return { ok: false, reason: 'that suggestion does not name two concepts to merge' };
				}
				if (!mergeNodes(p.nodeId, p.targetId, userId, 'groom')) {
					return { ok: false, reason: 'one of those concepts is gone, or is not yours to merge' };
				}
				break;
			}
			case 'connect': {
				if (!p.nodeId || !p.targetId) {
					return { ok: false, reason: 'that suggestion does not name what to connect it to' };
				}
				saveAssociation({
					sourceId: p.nodeId,
					targetId: p.targetId,
					weight: num(payload.weight),
					description: str(payload.why),
					userId,
					actor: 'groom',
					runId
				});
				break;
			}
			case 'disconnect': {
				if (!p.nodeId || !p.targetId) {
					return { ok: false, reason: 'that suggestion does not name a connection' };
				}
				// Either orientation: a symmetric connection is stored once, and which
				// way round is an implementation detail the suggestion did not choose.
				if (
					!deleteAssociation(p.nodeId, p.targetId, userId, 'groom') &&
					!deleteAssociation(p.targetId, p.nodeId, userId, 'groom')
				) {
					return { ok: false, reason: 'that connection is already gone' };
				}
				break;
			}
			case 'weight': {
				if (!p.nodeId || !p.targetId || num(payload.weight) === undefined) {
					return { ok: false, reason: 'that suggestion does not name a connection and a strength' };
				}
				saveAssociation({
					sourceId: p.nodeId,
					targetId: p.targetId,
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
				if (!p.nodeId) return { ok: false, reason: 'that suggestion does not name a concept' };
				const node = getNode(p.nodeId, userId);
				if (!node) return { ok: false, reason: 'that concept has been deleted since' };
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
				if (!p.nodeId) return { ok: false, reason: 'that suggestion does not name a concept' };
				if (!deleteNode(p.nodeId, userId, 'groom')) {
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
	dropped: { unknownConcept: number; badKind: number; noTitle: number };
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
	const dropped = { unknownConcept: 0, badKind: 0, noTitle: 0 };

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

		const nodeRef = typeof p.node === 'string' ? p.node : null;
		const targetRef = typeof p.target === 'string' ? p.target : null;
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

const KINDS = [
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

// --- the prompt -------------------------------------------------------------

function describeNode(node: CortexNode, userId: string): string {
	const links = listAssociations(node.id, userId)
		.map((e) => (e.sourceId === node.id ? e.targetId : e.sourceId))
		.join(', ');
	return `- ${node.id} "${node.name}"${node.isConvergence ? ' [bridge]' : ''} — ${node.description || '(no description)'}${links ? `\n    connects to: ${links}` : '\n    connects to: nothing'}`;
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
	const relevant = mode === 'harvest' ? new Set(seedNodes(activity, userId, 25).map((n) => n.id)) : null;
	const lattice = relevant
		? [
				nodes.filter((n) => relevant.has(n.id)).map((n) => describeNode(n, userId)).join('\n'),
				'--- EVERY OTHER CONCEPT (names only, so you do not propose one that exists) ---',
				nodes
					.filter((n) => !relevant.has(n.id))
					.map((n) => `- ${n.id} "${n.name}"`)
					.join('\n')
			].join('\n\n')
		: nodes.map((n) => describeNode(n, userId)).join('\n');

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
		'Reply with ONLY a JSON object: {"proposals":[…]}. Every item in it has "kind", "title" (one line) and "rationale" (why). What else it needs depends on the kind:',
		[
			'create   — payload {"name":"…","description":"…","areas":["area-id or a new area name"],"connect":[{"node":"node-id","weight":0.7,"why":"…"}]}. Connections are part of the suggestion, not a follow-up: a concept nothing links to can never surface in a query.',
			'merge    — "node": the one to keep, "target": the one folded into it.',
			'connect  — "node" and "target", payload {"weight":0.0-1.0,"why":"…"}.',
			'disconnect — "node" and "target".',
			'weight   — "node" and "target", payload {"weight":0.0-1.0}.',
			'circuit  — "node", payload {"areas":["area-id", …]} (the full set it should be in).',
			'convergence — "node", payload {"isConvergence":true|false}.',
			'rename   — "node", payload {"name":"…"}.',
			'delete   — "node".'
		].join('\n'),
		'Use the exact ids given above; a node id you invent will be dropped. Propose nothing you cannot justify from what you were shown.'
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
		const { text, usage, finishReason, reasonedOnly } = await choice.adapter.complete(
			{
				modelKey: choice.model.modelKey,
				messages: [
					{ role: 'system', content: taskCfg?.systemPrompt ?? '' },
					{ role: 'user', content: buildGroomPrompt(userId, max, mode, activity) }
				],
				// A reasoning model spends part of this thinking before it starts
				// answering, and 4096 was the budget for both — which is one of the
				// ways a run comes back with no text at all.
				maxTokens: 8192
			},
			AbortSignal.timeout(180_000)
		);
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
			reasonedOnly: reasonedOnly === true
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
		emitEvent({
			task: 'cortex-groom',
			userId,
			type: 'job',
			name: 'cortex.groom',
			status: 'error',
			durationMs: Date.now() - startedAt,
			detail: { trigger, mode, tidied, detected, error: err instanceof Error ? err.message : String(err) }
		});
		return { ran: false, mode, reason: 'model call failed', tidied, detected };
	}
}
