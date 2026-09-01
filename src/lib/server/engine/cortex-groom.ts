import { reasoningFor } from '$lib/server/providers/registry';
import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { cortexAssociations, cortexNodes, cortexProposals } from '$lib/server/db/schema';
import {
	adjacency,
	canEdit,
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
	noteGroomed,
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
 * What each pass asks for, which is the size of its **answer** and not the size
 * of the budget.
 *
 * `max_tokens` is not a safety ceiling. The adapter passes it straight through,
 * and on a reasoning model it is *permission to think* — hand one a large
 * number on an open-ended "find everything wrong with this" question and it
 * will spend a large fraction of it before writing a word. At any realistic
 * generation rate that alone is minutes, whatever the prompt says.
 *
 * That is how a six-kilobyte prompt came to take longer than three hundred
 * seconds. This job was asking for 16,384 tokens and, on retry, 65,536 — four
 * and sixteen times the largest budget anything else in this codebase uses.
 * For comparison, and these are the whole argument:
 *
 * - research triage: 200        - memory, all three calls: 2,048
 * - run summary, chat title: 256 - alignment: 3,072
 * - compaction: 1,024           - **the UX audit: 4,096**
 *
 * The UX audit reviews an entire application and returns structured findings.
 * It is the same job as this one and it does it in four thousand tokens. A
 * survey returns about twenty short JSON items — five hundred tokens. A close
 * read returns at most ten proposals with rationales — thirteen hundred. Both
 * numbers below are threefold headroom on that, and `cfg.maxTokens` remains a
 * ceiling over them for anyone who needs to pull them down.
 *
 * The rule this encodes: **ask for the size of the answer.** A budget larger
 * than the answer buys nothing except time, and time is the thing that was
 * running out.
 */
const SURVEY_TOKENS = 2_048;
const PROPOSAL_TOKENS = 4_096;

/**
 * How much a retry may add after a reasoning model writes nothing.
 *
 * Three times the pass's own ask, not a fixed floor. The floor this replaces
 * was `Math.max(cfg.maxTokens * 4, 32_768)`, copied from `research.ts` — which
 * multiplies a *small* base. Multiplying 16,384 by four gives 65,536, a number
 * no model finishes inside any timeout this app offers, so the retry that
 * existed to rescue a run was guaranteeing its failure. Taking a multiplier
 * from research without taking its base is the same mistake, in the same file,
 * that `3700e26` was written to fix.
 */
const RETRY_MULTIPLIER = 3;

/**
 * A retry is only worth making with real room to make it in.
 *
 * Below this share of the run, asking again buys an abort that reports itself
 * as a timeout — which is worse than not asking, because it hides why the first
 * call came back empty.
 */
const RETRY_MIN_SHARE = 0.2;

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
	/**
	 * How big the prompts were, and where the seconds actually went.
	 *
	 * Totals across every call the run made. A review makes two, and the panel
	 * has always shown one line for this — keeping these as the sum is what lets
	 * that line stay true without knowing how many passes there were.
	 */
	promptChars?: number;
	buildMs?: number;
	modelMs?: number;
	/** A call came back empty on length, so it was asked again with room. */
	retried?: boolean;
	/**
	 * What the model wrote, across every call, and which model wrote it.
	 *
	 * The number this job most needed and did not have. A completion count sitting
	 * near the token budget is the whole explanation of a slow run — `max_tokens`
	 * on a reasoning model is permission to think, not a safety ceiling — and the
	 * model name says whether the task is using the one somebody configured, since
	 * `pickModel` falls back to the first enabled model silently.
	 */
	completionTokens?: number;
	/**
	 * Of those, the ones spent thinking rather than answering.
	 *
	 * Part of `completionTokens`, not additional to it. The split is the point:
	 * a run that wrote 13,851 tokens against a 1,596-character reply spent about
	 * four hundred of them on the answer, and the rest is the wall clock.
	 */
	reasoningTokens?: number;
	modelKey?: string;
	/**
	 * The wide pass of a review: what it looked at, and what it came back with.
	 *
	 * Absent on a harvest, which is one call and has no survey.
	 */
	survey?: {
		/** Concepts in this run's window, and in the whole lattice. */
		concepts: number;
		total: number;
		/** The window did not reach the end; the next run picks up where it stopped. */
		more: boolean;
		/** How many concepts went forward for a close read. */
		candidates: number;
		/** Candidates naming a concept that does not exist. */
		dropped: number;
		/** The survey did not answer usefully, so the shortlist was picked without it. */
		fellBack: boolean;
		promptChars: number;
		modelMs: number;
		retried: boolean;
		completionTokens: number;
		reasoningTokens: number;
		/** What it was allowed to write, and how long it was given. */
		maxTokens: number;
		allowedMs: number;
	};
	/**
	 * The narrow pass of a review. Absent when the survey found nothing to read;
	 * `everything` when the lattice was small enough that no survey was needed.
	 */
	confirm?: {
		concepts: number;
		everything: boolean;
		promptChars: number;
		modelMs: number;
		retried: boolean;
		completionTokens: number;
		reasoningTokens: number;
		maxTokens: number;
		allowedMs: number;
	};
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

/** Whatever a concept reaches, in the orientation-free way an edge is stored. */
function neighbourIds(node: CortexNode, links: Map<string, CortexAssociation[]>): string[] {
	return (links.get(node.id) ?? []).map((e) => (e.sourceId === node.id ? e.targetId : e.sourceId));
}

/**
 * How many of one concept's connections either prompt spells out.
 *
 * A hub in a five-hundred-concept lattice reaches four hundred of them, and
 * writing those ids out is four kilobytes on a single line. Past a few dozen the
 * list has stopped being something a model reads and started being filler — what
 * it needed to know, that this concept is a hub, was clear at ten. Without the
 * cap one hub in the shortlist is enough to make the close read grow with the
 * lattice, which is the one thing it exists not to do.
 */
const MAX_CONNECTIONS_SHOWN = 40;

/** A concept's connections, spelled out to the cap and counted past it. */
function connectionList(node: CortexNode, links: Map<string, CortexAssociation[]>): string {
	const to = neighbourIds(node, links);
	if (!to.length) return 'nothing';
	const shown = to.slice(0, MAX_CONNECTIONS_SHOWN).join(', ');
	return to.length > MAX_CONNECTIONS_SHOWN
		? `${shown}, and ${to.length - MAX_CONNECTIONS_SHOWN} more`
		: shown;
}

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
	return `- ${node.id} "${node.name}"${node.isConvergence ? ' [bridge]' : ''} — ${node.description || '(no description)'}\n    connects to: ${connectionList(node, links)}`;
}

/** A concept the model only needs to know exists, so it does not propose it again. */
const nameOnly = (n: CortexNode) => `- ${n.id} "${n.name}"`;

/**
 * The areas this reader may see named.
 *
 * The same rule `circuitIndex` applies, and for the same reason: a label written
 * on a node somebody shared is *theirs*, and since the API accepts free strings
 * the id is often the label. A concept filed only under someone else's area
 * reads as unfiled from where this reader is standing, which is what it is.
 */
function visibleAreaIds(userId: string): Set<string> {
	return new Set(listCircuits(userId).map((c) => c.id));
}

function filedUnder(node: CortexNode, userId: string, areas: Set<string>): string[] {
	const mine = node.ownerId === userId || node.ownerId === null;
	return (node.circuits ?? []).filter((id) => mine || areas.has(id));
}

/**
 * One concept's *shape*, and not a word about what it means.
 *
 * Where it sits, whether it bridges, and what it reaches — everything a
 * structural fault is visible in, and nothing else. This is the line the wide
 * pass is built from, and leaving the description out is the point rather than
 * a saving: a survey that could read descriptions would start judging from them,
 * which is the expensive question the second pass exists to ask.
 *
 * It also carries what two whole sections of the old prompt used to say. A
 * concept with `{unfiled}` is waiting to be filed and a concept reaching
 * `nothing` cannot be found by any query — said in place, for every concept,
 * rather than in capped lists that showed the first thirty of each.
 */
function surveyLine(
	node: CortexNode,
	links: Map<string, CortexAssociation[]>,
	userId: string,
	areas: Set<string>
): string {
	const filed = filedUnder(node, userId, areas);
	return `- ${node.id} "${node.name}"${node.isConvergence ? ' [bridge]' : ''} {${filed.join(', ') || 'unfiled'}} → ${connectionList(node, links)}`;
}

/** The area index, which is what every agent navigates by. */
function areasList(userId: string): string {
	const { circuits } = circuitIndex(userId);
	return circuits.map((c) => `- ${c.id} "${c.name}" (${c.count})`).join('\n') || '(none defined)';
}

/**
 * What has already been settled, so nothing is raised twice.
 *
 * Every status, not just open ones: something accepted is done, and something
 * turned down was considered and declined. Re-raising either is how a review
 * queue teaches people to stop reading it.
 *
 * Two renderings, because the two passes recognise a repeat differently and one
 * of them cannot afford the good version. A pass asking for *proposals* needs
 * the titles — that is how it tells a rename it already suggested from one it
 * has not. A pass asking for *concept ids* only needs to know which concepts
 * have been argued over, and at two hundred rows the titles are ten to fifteen
 * kilobytes: on a survey prompt they were the largest section by some way, and
 * they were buying nothing that `merge tide-pools+rockpools` does not say.
 */
function decidedList(userId: string, by: 'title' | 'id' = 'title'): string {
	const rows = db
		.select({
			title: cortexProposals.title,
			status: cortexProposals.status,
			kind: cortexProposals.kind,
			nodeId: cortexProposals.nodeId,
			targetId: cortexProposals.targetId
		})
		.from(cortexProposals)
		.where(eq(cortexProposals.userId, userId))
		// Newest first, and ordered at all. This had no ORDER BY and then took the
		// first two hundred, so *which* two hundred was the database's choice —
		// the same fault the activity trawl had, where `.slice(0, 30)` on an
		// unordered query kept the oldest thirty of a conversation. What a model
		// is most likely to repeat is what was suggested last.
		.orderBy(desc(cortexProposals.createdAt), cortexProposals.id)
		.all()
		.slice(0, DECIDED_SHOWN);
	if (by === 'title') {
		return rows.map((p) => `- [${p.status}] ${p.title}`).join('\n') || '(nothing yet)';
	}
	return (
		rows
			// A `create` has no concept yet, so there is no id to recognise it by and
			// nothing useful to say here. It is not a thing a survey proposes anyway.
			.filter((p) => p.nodeId)
			.map(
				(p) => `- [${p.status}] ${p.kind} ${p.nodeId}${p.targetId ? `+${p.targetId}` : ''}`
			)
			.join('\n') || '(nothing yet)'
	);
}

/**
 * The exact shape each kind of suggestion has to arrive in.
 *
 * One copy, shared by both prompts that ask for proposals, because this block is
 * where a misreading costs a whole run's output. Whole objects rather than a
 * shorthand: the shorthand read `circuit — "node", payload {"areas":[…]}`, which
 * compresses two nesting levels into one comma, and a model read it as "circuit
 * takes a node and a payload" and put the node *inside* the payload. The
 * suggestion was right and unusable, and there was no way to tell from the row.
 */
const SHAPE_BY_KIND: Record<Kind, string> = {
	create:
		'create — the concept does not exist yet, so it has no "node":\n{"kind":"create","title":"…","rationale":"…","payload":{"name":"…","description":"…","areas":["area-id or a new area name"],"connect":[{"node":"node-id","weight":0.7,"why":"…"}]}}\nConnections are part of the suggestion, not a follow-up: a concept nothing links to can never surface in a query.',
	merge:
		'merge — "node" is the one to keep, "target" the one folded into it:\n{"kind":"merge","title":"…","rationale":"…","node":"node-id","target":"node-id"}',
	connect:
		'connect:\n{"kind":"connect","title":"…","rationale":"…","node":"node-id","target":"node-id","payload":{"weight":0.7,"why":"…"}}',
	disconnect:
		'disconnect:\n{"kind":"disconnect","title":"…","rationale":"…","node":"node-id","target":"node-id"}',
	weight:
		'weight — the strength is required, or there is no change to make:\n{"kind":"weight","title":"…","rationale":"…","node":"node-id","target":"node-id","payload":{"weight":0.7}}',
	circuit:
		'circuit — "areas" is the full set the concept should be in, and is required:\n{"kind":"circuit","title":"…","rationale":"…","node":"node-id","payload":{"areas":["area-id"]}}',
	convergence:
		'convergence:\n{"kind":"convergence","title":"…","rationale":"…","node":"node-id","payload":{"isConvergence":true}}',
	rename:
		'rename — the new name is required:\n{"kind":"rename","title":"…","rationale":"…","node":"node-id","payload":{"name":"…"}}',
	delete: 'delete:\n{"kind":"delete","title":"…","rationale":"…","node":"node-id"}'
};

/**
 * The shapes for the kinds this pass may actually propose.
 *
 * All nine used to go in every prompt, which on a nine-concept lattice was
 * ~2,600 characters of schema against ~4,000 of actual lattice — the model read
 * more instruction than data. A pass that cannot propose a `create` has no use
 * for its shape, and every line of unused instruction is something a reasoning
 * model dutifully considers.
 */
function proposalShapes(kinds: readonly Kind[]): string[] {
	return [
		'Reply with ONLY a JSON object: {"proposals":[…]}. Every item has "kind", "title" (one line) and "rationale" (why), plus whatever its kind needs below.',
		'"node" and "target" are always top-level keys, beside "kind" and "title" — never inside "payload". Copy the shape of these exactly:',
		kinds.map((k) => SHAPE_BY_KIND[k]).join('\n\n'),
		'Use the exact ids given above; a node id you invent will be dropped, and so will a suggestion missing anything its kind requires. Propose nothing you cannot justify from what you were shown.'
	];
}

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
 * How much of a harvest prompt the concept descriptions may take.
 *
 * A harvest rations by *relevance* rather than by cost — only what the new
 * conversation actually touches is worth describing, however much room there is
 * — and this is the ceiling on top of that, for the case where a busy window
 * touches most of a large lattice. Every concept still appears by name, so
 * nothing is proposed twice.
 */
const LATTICE_BUDGET_CHARS = 24_000;

/**
 * How much of the lattice one survey may cover.
 *
 * Structure-only lines are cheap — roughly a third of a described concept, and
 * far less on anything with a long description — but cheap is not free, and the
 * per-user cap is two thousand concepts. Past this the survey covers a window
 * and the cursor carries the rest to the next run, so a run costs two calls
 * whatever the lattice is doing.
 */
const SURVEY_BUDGET_CHARS = 60_000;

/**
 * How many one-hop neighbours the close read may name.
 *
 * Context for the shortlist, not a second lattice. Without a cap a single hub in
 * the shortlist brings its whole spoke set along and the narrow pass is wide
 * again — which is the one thing it must not be.
 */
const MAX_NEIGHBOURS = 60;

/**
 * How many settled suggestions either prompt lists.
 *
 * Was two hundred, which on a lattice with any history was the largest section
 * in the prompt — bigger than the lattice itself on a fifty-concept review.
 *
 * It can be this small because it is not the guarantee. `recordProposals`
 * fingerprints every suggestion against every row this person has ever had, at
 * every status, and drops a repeat mechanically. This list exists so the model
 * does not *spend a slot* on something already settled, which is a matter of
 * the handful it just saw rather than of complete history.
 */
const DECIDED_SHOWN = 60;

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
 * The harvest prompt: what has been said, and enough of the lattice to not
 * propose something already in it.
 *
 * The scheduled pass, and it is about *adding*. Full detail for the concepts
 * `seedNodes` says bear on the new activity, bare names for the rest — reusing
 * the retrieval machinery to pick that slice beats inventing a second notion of
 * relevance. It stays one call: its prompt is small by construction, and the
 * failure it actually had was output tokens, which the retry answers.
 */
export function buildHarvestPrompt(userId: string, max: number, activity = ''): string {
	const nodes = listNodes(userId);
	const { unfiled } = circuitIndex(userId);
	const links = adjacency(userId);

	// Capped: on a large lattice this is the one unbounded list in the prompt,
	// and a hundred unfiled concepts would crowd out everything else.
	const unfiledNodes = nodes.filter((n) => !n.circuits?.length).slice(0, 30);
	// Capped for the same reason: on a lattice that has never been connected this
	// is every concept, and it would crowd out the activity the pass is here for.
	const stranded = orphans(userId).slice(0, 30);

	const relevant = new Set(seedNodes(activityGist(activity), userId, 25).map((n) => n.id));
	const candidates = nodes.filter((n) => relevant.has(n.id));
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

	return [
		`--- WHAT HAS HAPPENED SINCE THE LAST PASS ---\n${activity || '(nothing new)'}`,
		`--- THE LATTICE (${nodes.length} concepts) ---`,
		lattice,
		`--- AREAS ---`,
		areasList(userId),
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
		decidedList(userId),
		`--- YOUR TASK ---`,
		[
			`Propose at most ${max} concepts worth adding, based on what was said.`,
			'A concept is a thing facts can be about, not a fact — "prefers dark themes" is an observation, "visual design" is a concept. Propose one only when it would help answer a later question about this person, and give each the connections that make it reachable.',
			'Nothing worth adding is a fine answer. Reply with an empty list.',
			'Also file anything under NOT YET FILED: nothing else can put a concept in an area, so those are waiting on you. Use an existing area wherever one fits — the index is what every agent navigates by, so it is worth keeping small — and only name a new one when nothing does.'
		].join(' '),
		// A harvest adds and files. It is not asked to consolidate, so the seven
		// shapes for consolidating are seven paragraphs of instruction it would
		// have to read and then not use.
		...proposalShapes(['create', 'circuit'])
	].join('\n\n');
}

// --- a review, in two passes ------------------------------------------------

/**
 * A review used to be one call, and on any lattice worth reviewing it timed out.
 *
 * The prompt was not the whole story. At fifty-two concepts it was around 25KB,
 * well inside any model's window, and it still burned three minutes. The cost
 * was the *reasoning load*: one model, in one shot, holding every concept's
 * name, description and connections in mind **and** producing ten justified
 * structural changes. A hard question over a wide input, getting harder as the
 * square of the lattice while the model's patience stays flat.
 *
 * So it asks two easy questions instead of one hard one.
 *
 * **The survey** is a wide input and a shallow question. Names, areas and
 * connections; no descriptions. "Which of these look wrong from their shape
 * alone?" It answers with a shortlist and a one-line hypothesis each, which is
 * cheap to read and cheap to write.
 *
 * **The confirmation** is a narrow input and a deep question. Those concepts,
 * now with their descriptions and their neighbours. "Do the descriptions bear
 * this out? Adjust it, or drop it."
 *
 * Neither call asks the model to do the hard thing over the whole lattice. The
 * bytes fall too — descriptions are most of a concept's line, and the unfiled
 * list, the orphan list and the recorded observations all move to the narrow
 * pass — but the split in reasoning is what actually buys the seconds back.
 */

/** What a survey may suspect: everything except adding a concept from nothing. */
const SURVEY_KINDS = KINDS.filter((k) => k !== 'create');

/** A concept the survey pointed at, and what it suspected about it. */
export interface Candidate {
	node: CortexNode;
	target?: CortexNode;
	kind?: string;
	hypothesis?: string;
}

export interface SurveyWindow {
	window: CortexNode[];
	covered: number;
	total: number;
}

/**
 * The order a survey works through a lattice: longest neglected first.
 *
 * Never groomed leads — a concept nothing has ever looked at is the one the
 * groomer owes attention to, and a newly added concept gets it on the next run
 * without anything having to remember that it is new. Then oldest stamp.
 *
 * `judgingOrder` breaks the ties, so on a small lattice — where every concept
 * carries the same stamp, or none — the order falls back to what is most worth
 * judging: most connected, then unfiled, then recently touched. That is the
 * right behaviour and it costs nothing to get.
 *
 * This replaces a stored cursor holding one concept id into name order. The
 * cursor was disturbed by a deletion, said nothing about concepts added since,
 * and could not answer the only question worth asking of it — whether the
 * groomer has been all the way round.
 */
export function groomingOrder(
	nodes: CortexNode[],
	links: Map<string, CortexAssociation[]>
): CortexNode[] {
	const byJudgement = new Map(judgingOrder(nodes, links).map((n, i) => [n.id, i]));
	return [...nodes].sort((a, b) => {
		const left = a.lastGroomedAt?.getTime() ?? 0;
		const right = b.lastGroomedAt?.getTime() ?? 0;
		if (left !== right) return left - right;
		return (byJudgement.get(a.id) ?? 0) - (byJudgement.get(b.id) ?? 0);
	});
}

/**
 * As much of the lattice as one survey can carry, longest-neglected first.
 *
 * Everything left over is simply next run's work: the stamps written by this
 * one push these concepts to the back, so the window walks the whole lattice
 * without anything having to remember where it stopped. A run costs two calls
 * whatever the lattice is doing, and — unlike the ceiling this replaces, which
 * dropped the tail — there is no part of a large lattice that no review ever
 * reaches.
 */
export function surveyWindow(
	nodes: CortexNode[],
	line: (n: CortexNode) => string,
	budget = SURVEY_BUDGET_CHARS
): SurveyWindow {
	const window: CortexNode[] = [];
	let spent = 0;
	for (const node of nodes) {
		const cost = line(node).length + 1;
		// `window.length` guards the degenerate case: one concept whose line alone
		// exceeds the budget still gets surveyed. Without it the window could come
		// back empty and nothing would ever be stamped.
		if (spent + cost > budget && window.length) break;
		spent += cost;
		window.push(node);
	}
	return { window, covered: window.length, total: nodes.length };
}

/** The wide, shallow pass: structure only, and a shortlist out. */
export function buildSurveyPrompt(
	userId: string,
	shortlist: number,
	window: CortexNode[],
	total: number,
	line: (n: CortexNode) => string
): string {
	return [
		'--- A SURVEY OF THE LATTICE’S SHAPE ---',
		'You are looking at structure only. Descriptions are deliberately withheld: this pass decides what is worth reading closely, and a second pass will read it. Do not judge what a concept *means* from its name — say what looks wrong about where it sits.',
		`--- THE CONCEPTS (${window.length}${total > window.length ? ` of ${total}, the rest on a later pass` : ''}) ---`,
		'Each line is: id, name, [bridge] if it joins areas, {areas it is filed under} and → what it connects to.',
		window.map(line).join('\n') || '(none)',
		`--- AREAS ---`,
		areasList(userId),
		`--- CONCEPTS ALREADY ARGUED OVER (do not point at these again) ---`,
		decidedList(userId, 'id'),
		`--- YOUR TASK ---`,
		[
			`Name at most ${shortlist} concepts worth a closer look, and say what you suspect about each in one line.`,
			'What is visible from here: a concept marked {unfiled}, which nothing but this job can file; a concept reaching → nothing, which no query can find; two names that look like one concept; a concept connecting several areas that is not marked [bridge]; a cluster with no connection leaving it, which adds nothing plain search would not already find; two concepts that plainly relate and are not connected.',
			'Near-duplicate names and connections that have faded are already found without you — do not spend a slot on them unless you can say something a string match could not.',
			'Nothing worth a closer look is a fine answer. Reply with an empty list.'
		].join(' '),
		'Reply with ONLY a JSON object: {"candidates":[…]}. Every item has "node" (an id from above), "kind" (one of ' +
			// `create` is deliberately not on offer. Every candidate is a concept id
			// and a `create`'s concept does not exist yet, so there would be nothing
			// to name it by — adding a concept is a harvest's job, from what was
			// actually said, not something to infer from a gap in a shape.
			SURVEY_KINDS.join(', ') +
			'), and "hypothesis" — **at most ten words**, since the next pass reads the descriptions and forms its own view. Add "target" (another id) when the suspicion is about a pair — a merge, a connection, a weight.',
		'{"candidates":[{"node":"node-id","target":"node-id","kind":"merge","hypothesis":"same area, same neighbours"}]}',
		'Use the exact ids given above. An id you invent is dropped, and costs you a slot.'
	].join('\n\n');
}

/**
 * The narrow, deep pass: these concepts in full, and the final suggestions out.
 *
 * The shortlist with descriptions and connections, one hop of neighbours by
 * name so a merge or a new connection can be judged against what is already
 * there, and — for the first time in the run — the recorded observations, which
 * are text and belong with the pass that reads text.
 */
export function buildConfirmPrompt(
	userId: string,
	max: number,
	candidates: Candidate[],
	links: Map<string, CortexAssociation[]> = adjacency(userId)
): string {
	const nodes = listNodes(userId);
	const byId = new Map(nodes.map((n) => [n.id, n]));

	// The shortlisted concepts and whatever a paired suspicion names, in the
	// lattice's own order rather than the survey's — the model is reading this
	// to hold a shape in mind.
	const wanted = new Set<string>();
	for (const c of candidates) {
		wanted.add(c.node.id);
		if (c.target) wanted.add(c.target.id);
	}
	const inFull = nodes.filter((n) => wanted.has(n.id));

	/**
	 * One hop out, by name and capped.
	 *
	 * Judging a merge means knowing what the two already reach; judging a new
	 * connection means knowing what is already connected. Names only, because
	 * this is context rather than the thing being judged — and capped, because a
	 * shortlist containing one hub drags its entire spoke set in here and the
	 * narrow pass stops being narrow. Measured: uncapped, twenty concepts out of
	 * fifty-two pulled in most of the lattice.
	 *
	 * The ones touching the most shortlisted concepts survive the cap, since a
	 * concept two of the candidates both reach is the one a merge is most likely
	 * to turn on.
	 */
	const around = new Map<string, number>();
	for (const node of inFull) {
		for (const id of neighbourIds(node, links)) {
			if (!wanted.has(id)) around.set(id, (around.get(id) ?? 0) + 1);
		}
	}
	const kept = new Set(
		[...around.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, MAX_NEIGHBOURS)
			.map(([id]) => id)
	);
	const neighbours = nodes.filter((n) => kept.has(n.id));
	const unshown = around.size - kept.size;

	const suspicions = candidates
		.filter((c) => c.hypothesis || c.kind)
		.map(
			(c) =>
				`- ${c.kind ?? 'look at'} ${c.node.id}${c.target ? ` + ${c.target.id}` : ''}: ${c.hypothesis ?? '(no reason given)'}`
		);

	return [
		'--- A CLOSE READ OF WHAT THE SURVEY TURNED UP ---',
		'A first pass looked at the whole lattice’s shape — names, areas and connections, no descriptions — and picked these out. Now you have the descriptions it could not see.',
		`--- THE CONCEPTS TO JUDGE (${inFull.length}) ---`,
		inFull.map((n) => describeNode(n, links)).join('\n') || '(none)',
		neighbours.length
			? `--- WHAT THEY ALREADY CONNECT TO (${neighbours.length}${unshown ? ` of ${around.size}` : ''}; names only) ---\n` +
				neighbours.map(nameOnly).join('\n')
			: 'they connect to nothing outside the list above',
		`--- AREAS ---`,
		areasList(userId),
		suspicions.length
			? `--- WHAT THE SURVEY SUSPECTED ---\n${suspicions.join('\n')}`
			: '--- THE SURVEY DID NOT ANSWER ---\nThese are the concepts most worth judging, chosen without it: the unreachable, the unfiled, and the most connected. Say what you find.',
		// Read-only, and one-directional: the groomer may notice that a recorded
		// observation implies a concept, and never writes back to memory.
		`--- RECORDED OBSERVATIONS (never edit these) ---`,
		listMemoryItems(userId)
			.filter((m) => m.status === 'active')
			.slice(0, 60)
			.map((m) => `- (${m.kind}) ${m.content}`)
			.join('\n') || '(none)',
		`--- ALREADY DECIDED (do not raise again) ---`,
		decidedList(userId),
		`--- YOUR TASK ---`,
		[
			`Suggest at most ${max} changes that would make this lattice better at answering questions about its owner.`,
			'Confirm what the survey suspected where the descriptions bear it out, adjust it where they say something different, and drop it where they contradict it — two concepts whose names look alike and whose descriptions do not are two concepts.',
			'Dropping everything is a fine answer. Do not invent a suggestion to fill the number; a suggestion nobody can justify costs somebody a decision.',
			'Also file anything shown as unfiled: nothing else can put a concept in an area. Prefer an existing area — the index is what every agent navigates by, so it is worth keeping small.'
		].join(' '),
		// Everything except `create`: a close read judges concepts it was shown,
		// and adding one from nothing is a harvest's job, done from what was
		// actually said rather than inferred from a gap in a shape.
		...proposalShapes(SURVEY_KINDS)
	].join('\n\n');
}

/**
 * The survey, ready to send, and which concepts went into it.
 *
 * Only concepts this person owns rotate. Ones somebody else shared are pinned
 * into the listing as context and never stamped — they cannot be stamped
 * without crossing the ownership boundary, and leaving them unstamped *inside*
 * the rotation would park them at the front of every survey for ever and
 * starve the lattice they were meant to give context to.
 */
export function buildSurvey(
	userId: string,
	shortlist: number,
	links: Map<string, CortexAssociation[]> = adjacency(userId)
) {
	const areas = visibleAreaIds(userId);
	const all = listNodes(userId);
	const mine = all.filter((n) => canEdit(n, userId));
	const theirs = all.filter((n) => !canEdit(n, userId));
	const line = (n: CortexNode) => surveyLine(n, links, userId, areas);

	const { window, covered, total } = surveyWindow(groomingOrder(mine, links), line);
	// Listed in the lattice's own order rather than the priority order's: the
	// model is reading this to hold a shape in mind, and a list sorted by how
	// long each concept has been waiting is a harder shape to hold.
	const shown = new Set(window.map((n) => n.id));
	const listed = all.filter((n) => shown.has(n.id) || theirs.includes(n));

	return {
		prompt: buildSurveyPrompt(userId, shortlist, listed, total, line),
		window,
		links,
		covered,
		total
	};
}

/**
 * Every concept, as candidates, for a lattice small enough not to need a survey.
 *
 * No hypotheses, because nothing suspected anything — the close-read prompt
 * says so rather than passing this off as a shortlist a model chose.
 */
export function everyConcept(
	userId: string,
	links: Map<string, CortexAssociation[]> = adjacency(userId)
): Candidate[] {
	const mine = listNodes(userId).filter((n) => canEdit(n, userId));
	return judgingOrder(mine, links).map((node) => ({ node }));
}

/**
 * Turn what the survey said into concepts that exist.
 *
 * The same courtesy `recordProposals` extends to a proposal: ids are what the
 * prompt asks for, names are what a model sometimes sends, and an id it invented
 * is dropped here rather than being allowed to spend the deep pass's budget on a
 * concept that is not there.
 */
export function readCandidates(
	userId: string,
	raw: unknown[],
	max: number
): { candidates: Candidate[]; dropped: number } {
	const candidates: Candidate[] = [];
	const seen = new Set<string>();
	let dropped = 0;
	const find = (ref: unknown): CortexNode | undefined => {
		const wanted = typeof ref === 'string' ? ref.trim() : '';
		if (!wanted) return undefined;
		return getNode(wanted, userId) ?? findNodeByName(wanted, userId) ?? undefined;
	};

	for (const item of raw.slice(0, max)) {
		const c = (item ?? {}) as Record<string, unknown>;
		const node = find(c.node);
		if (!node) {
			dropped++;
			continue;
		}
		const target = find(c.target);
		// Keyed on the pair: a survey that names the same merge twice should not
		// buy the same concept two slots in the deep pass.
		const key = [node.id, target?.id ?? ''].sort().join('|');
		if (seen.has(key)) continue;
		seen.add(key);
		const kind = String(c.kind ?? '').trim();
		candidates.push({
			node,
			target: target && target.id !== node.id ? target : undefined,
			kind: (SURVEY_KINDS as readonly string[]).includes(kind) ? kind : undefined,
			hypothesis: String(c.hypothesis ?? '').trim().slice(0, 400) || undefined
		});
	}
	return { candidates, dropped };
}

/**
 * The shortlist a review falls back on when the survey does not answer.
 *
 * A wide pass that returns prose, or nothing, should not cost the whole run:
 * the deep pass is affordable by construction, and there is a defensible
 * shortlist to be had without a model. Never read before leads — no model has
 * ever seen what these concepts say, which is the plainest claim on attention
 * there is — then unreachable and unfiled, the two faults only this job can
 * fix, then whatever `judgingOrder` puts on top.
 */
export function shortlistFallback(
	userId: string,
	links: Map<string, CortexAssociation[]>,
	max: number
): Candidate[] {
	const mine = listNodes(userId).filter((n) => canEdit(n, userId));
	const stranded = new Set(orphans(userId).map((o) => o.id));
	const ranked = [
		...mine.filter((n) => !n.lastExaminedAt),
		...mine.filter((n) => stranded.has(n.id)),
		...mine.filter((n) => !stranded.has(n.id) && !n.circuits?.length),
		...judgingOrder(mine, links)
	];
	const seen = new Set<string>();
	const out: Candidate[] = [];
	for (const node of ranked) {
		if (seen.has(node.id)) continue;
		seen.add(node.id);
		out.push({ node });
		if (out.length >= max) break;
	}
	return out;
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
	/**
	 * Suggestions this run may raise, and never more than the lattice can bear.
	 *
	 * Asking for "at most 10 changes" across nine concepts invites a model to
	 * work for ten, which is the same over-ask that had a survey naming twenty
	 * concepts out of fifteen. A third of the lattice is a generous ceiling on
	 * how much of it can really want changing at once.
	 */
	const max = Math.max(
		1,
		Math.min(cfg.maxProposalsPerRun, 25, Math.ceil(listNodes(userId).length / 3) || 1)
	);
	const shortlist = Math.max(
		1,
		Math.min(cfg.shortlistSize ?? DEFAULT_CORTEX_GROOM.shortlistSize, 100)
	);

	// Free, and so unconditional: tidying and the detectors run on every pass
	// whether or not a model is configured, and whichever job this is.
	const tidied = tidy(userId, runId);
	// Uncapped, unlike the model's half. These are graph facts rather than
	// opinions, they cost nothing to find, and capping them meant a lattice with
	// thirty orphans filed the same first ten every run and never got to the
	// rest. The per-run cap is there to stop a model burying the queue.
	//
	// It is also what makes the survey's rotating window safe: near-duplicate
	// names are found here, over the whole lattice at once, so a pair split
	// across two survey windows is not a pair anybody loses.
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
	/**
	 * One deadline for the **run**, not one per call.
	 *
	 * A review makes two calls now, and giving each the configured limit would
	 * quietly mean twice it. A manual run is one synchronous request held open
	 * for its duration, so the number a person put in this box is the number
	 * their reverse proxy's read timeout was set against — it has to mean what
	 * they think it means.
	 */
	const deadline = startedAt + cfg.timeoutSeconds * 1000;
	/**
	 * What is honestly left, which may be nothing at all.
	 *
	 * Kept separate from what a signal is handed, below. Folding the floor into
	 * this made "the run is nearly out of time" indistinguishable from "there is
	 * a second left", so anything trying to decide whether another call is worth
	 * making could not tell.
	 */
	const remainingMs = () => deadline - Date.now();
	// A signal already past its deadline aborts before the request is even made,
	// which reports a timeout without having waited for one.
	const allow = (ms: number) => Math.max(ms, 1_000);
	const remaining = () => allow(remainingMs());
	/**
	 * The survey gets everything except a floor held back for the close read.
	 *
	 * Not a flat half, which is what this was and what starved it. The close
	 * read's prompt is bounded by the shortlist rather than by the lattice, so it
	 * is the pass whose need can be predicted; the survey is the unbounded one
	 * and gets the larger share. A survey that comes back quickly hands the rest
	 * forward.
	 */
	const CLOSE_READ_SHARE = 0.25;
	const surveyLimit = () =>
		allow(remainingMs() - Math.floor(cfg.timeoutSeconds * 1000 * CLOSE_READ_SHARE));

	// Which pass a failure happened in. "The model did not answer" was already
	// the least useful sentence in the system when there was one call to blame.
	let stage: 'harvest' | 'survey' | 'confirm' = mode === 'harvest' ? 'harvest' : 'survey';
	let survey: GroomResult['survey'];
	let confirm: GroomResult['confirm'];

	try {
		/**
		 * One call, with the retry that keeps a reasoning model from wasting a run.
		 *
		 * A reasoning model can spend the whole budget thinking and return no
		 * answer at all. That is what a 52-concept lattice did on 4,860 characters
		 * of conversation: `finishReason: "length"`, `reasonedOnly: true`, nothing
		 * written. So it retries once with real headroom, the same rule and the
		 * same gate `research.ts` has used for this since it shipped: nothing came
		 * back *and* it hit the wall. A model that simply had nothing to suggest
		 * returns an empty list and never triggers this, so the common path pays
		 * nothing.
		 *
		 * The time limit is recomputed per call rather than captured, so a retry
		 * spends what is left of the run rather than starting the clock again.
		 */
		const ask = async (prompt: string, want: number, limit: () => number) => {
			// `cfg.maxTokens` is a ceiling over the pass's own ask, never the ask
			// itself. Raising the setting must not make a pass slower; lowering it
			// must still bite.
			const budget = (tokens: number) => Math.max(Math.min(cfg.maxTokens, tokens), 256);
			const call = async (maxTokens: number) => {
				const allowedMs = limit();
				const res = await choice.adapter.complete(
					{
						modelKey: choice.model.modelKey,
						messages: [
							{ role: 'system', content: taskCfg?.systemPrompt ?? '' },
							{ role: 'user', content: prompt }
						],
						maxTokens,
						// A survey reads a graph and names concepts; a close read reads
						// descriptions and emits JSON. Neither is a deliberation task, and
						// reasoning tokens are output tokens — they are the wall clock.
						// This is the lever that was missing while three fixes moved
						// `maxTokens` and the timeout under it, neither of which governs
						// how long a model thinks.
						reasoning: reasoningFor(choice, 'low')
					},
					AbortSignal.timeout(allowedMs)
				);
				// Per call, not per ask. This used to run once after the retry, so a
				// run that timed out wrote no usage row at all — and completion
				// tokens were the one number that would have explained the timeout.
				logUsage('cortex-groom', choice.model.modelKey, res.usage, 'ok', userId);
				return { ...res, allowedMs };
			};

			const askedAt = Date.now();
			let res = await call(budget(want));
			let retried = false;
			/**
			 * A reasoning model can spend the whole budget thinking and return no
			 * answer. The gate is `research.ts`'s and unchanged: nothing came back
			 * *and* it hit the wall. A model that simply had nothing to suggest
			 * returns an empty list and never triggers this.
			 *
			 * What is new is the second condition. Asking again with no time left
			 * returns an abort that reads as a timeout, which hides the reason the
			 * first call came back empty — so below a real share of the run it says
			 * so instead of spending a call to say nothing.
			 */
			const roomToRetry = remainingMs() > cfg.timeoutSeconds * 1000 * RETRY_MIN_SHARE;
			if (!res.text.trim() && (res.reasonedOnly === true || res.finishReason === 'length')) {
				if (roomToRetry) {
					retried = true;
					res = await call(budget(want * RETRY_MULTIPLIER));
				}
			}
			return {
				text: res.text,
				finishReason: res.finishReason ?? null,
				reasonedOnly: res.reasonedOnly === true,
				retried,
				// The two numbers that were missing. "It wrote 13,851 tokens, 13,450 of
				// them thinking" is the whole diagnosis of a slow run, and the split
				// is the half that matters: a long answer and a long deliberation
				// have the same completion count and only one of them is a fault.
				completionTokens: res.usage?.completionTokens ?? 0,
				reasoningTokens: res.usage?.reasoningTokens ?? 0,
				maxTokens: budget(want),
				allowedMs: res.allowedMs,
				promptChars: prompt.length,
				modelMs: Date.now() - askedAt
			};
		};

		let buildMs = 0;
		let promptChars = 0;
		let modelMs = 0;
		let retried = false;
		let completionTokens = 0;
		let reasoningTokens = 0;
		let reply = { text: '', finishReason: null as string | null, reasonedOnly: false };
		let proposals: unknown[] = [];
		/** Every concept whose shape reached the model, so the run can stamp them. */
		let looked: string[] = [];
		/** Every concept whose description reached the model. */
		let examined: string[] = [];

		if (mode === 'harvest') {
			const builtAt = Date.now();
			const prompt = buildHarvestPrompt(userId, max, activity);
			buildMs = Date.now() - builtAt;

			const res = await ask(prompt, PROPOSAL_TOKENS, remaining);
			reply = res;
			promptChars = res.promptChars;
			modelMs = res.modelMs;
			retried = res.retried;
			completionTokens = res.completionTokens;
			reasoningTokens = res.reasoningTokens;

			// `.proposals`, not the parsed value itself: extractJson returns an
			// object by construction, so a prompt asking for a bare array gets
			// nothing back however well the model complied. See json.ts.
			const parsed = extractJson(res.text);
			proposals = Array.isArray(parsed?.proposals) ? parsed.proposals : [];
		} else {
			const links = adjacency(userId);
			let candidates: Candidate[];

			/**
			 * A survey earns its call only when it has something to choose from.
			 *
			 * With no more concepts than the close read can hold, every one of them
			 * goes forward anyway — so the wide pass is a whole model call spent
			 * selecting all of them, and then a second call to do the work. Derived
			 * rather than a threshold somebody picked: the survey exists to choose,
			 * and with nothing to choose it is overhead.
			 */
			if (nodes.length <= shortlist) {
				candidates = everyConcept(userId, links);
			} else {
				stage = 'survey';
				const builtAt = Date.now();
				const wide = buildSurvey(userId, shortlist, links);
				buildMs = Date.now() - builtAt;

				const first = await ask(wide.prompt, SURVEY_TOKENS, surveyLimit);
				reply = first;
				promptChars = first.promptChars;
				modelMs = first.modelMs;
				retried = first.retried;
				completionTokens = first.completionTokens;
				reasoningTokens = first.reasoningTokens;
				looked = wide.window.map((n) => n.id);

				const parsed = extractJson(first.text);
				const raw = Array.isArray(parsed?.candidates) ? (parsed.candidates as unknown[]) : null;
				const read = raw ? readCandidates(userId, raw, shortlist) : { candidates: [], dropped: 0 };
				/**
				 * An empty list is an answer; anything else is the survey failing.
				 *
				 * The same distinction the retry gate draws, and for the same reason.
				 * A model that looked at the shape and found nothing must be believed
				 * — finding nothing is the commonest outcome the groomer has. But
				 * prose, a missing `candidates` key, or a list where every id was
				 * invented is a pass that did not answer, and the deep read is cheap
				 * enough to run on a shortlist picked without it rather than throw
				 * the run away.
				 */
				const answeredEmpty = Array.isArray(raw) && raw.length === 0;
				const fellBack = !answeredEmpty && !read.candidates.length;
				candidates = fellBack ? shortlistFallback(userId, links, shortlist) : read.candidates;

				survey = {
					concepts: wide.covered,
					total: wide.total,
					more: wide.covered < wide.total,
					candidates: candidates.length,
					dropped: read.dropped,
					fellBack,
					promptChars: first.promptChars,
					modelMs: first.modelMs,
					retried: first.retried,
					completionTokens: first.completionTokens,
					reasoningTokens: first.reasoningTokens,
					maxTokens: first.maxTokens,
					allowedMs: first.allowedMs
				};
			}

			if (candidates.length) {
				stage = 'confirm';
				const deepAt = Date.now();
				const deepPrompt = buildConfirmPrompt(userId, max, candidates, links);
				buildMs += Date.now() - deepAt;

				const second = await ask(deepPrompt, PROPOSAL_TOKENS, remaining);
				reply = second;
				promptChars += second.promptChars;
				modelMs += second.modelMs;
				retried = retried || second.retried;
				completionTokens += second.completionTokens;
				reasoningTokens += second.reasoningTokens;
				examined = [
					...new Set(
						candidates.flatMap((c) => (c.target ? [c.node.id, c.target.id] : [c.node.id]))
					)
				];
				// A close read over the whole lattice has also seen every shape.
				if (!survey) looked = examined;
				confirm = {
					concepts: examined.length,
					everything: !survey,
					promptChars: second.promptChars,
					modelMs: second.modelMs,
					retried: second.retried,
					completionTokens: second.completionTokens,
					reasoningTokens: second.reasoningTokens,
					maxTokens: second.maxTokens,
					allowedMs: second.allowedMs
				};

				const deep = extractJson(second.text);
				proposals = Array.isArray(deep?.proposals) ? deep.proposals : [];
			}
			// Otherwise the survey read the lattice's shape and found nothing worth
			// a closer look. One call, and an honest nothing.
		}

		// Stamped only on a run that reached the model, the same condition the
		// harvest watermark uses — and only on concepts this person may write to.
		noteGroomed(looked, 'lastGroomedAt', userId);
		noteGroomed(examined, 'lastExaminedAt', userId);

		const { added, duplicates, dropped } = recordProposals(userId, proposals, max);
		// Sizes, not content — the rule that no concept text reaches an event
		// detail still holds. Enough to tell a model that said nothing from one
		// that said plenty and had none of it parsed, which is the ambiguity
		// behind "it ran but there was no output".
		const shape = {
			replyChars: reply.text.length,
			parsedItems: proposals.length,
			activityChars: activity.length,
			windowHours: Math.round((Date.now() - watermark) / 3_600_000),
			finishReason: reply.finishReason,
			// The failure research.ts already names: chain-of-thought on its own
			// channel, no answer text, and indistinguishable from silence without
			// this flag.
			reasonedOnly: reply.reasonedOnly,
			// What the model actually wrote, and which model wrote it. Neither was
			// reported, and between them they are the whole diagnosis of a slow
			// run: a completion-token count near the budget says the model was
			// given permission to think for minutes, and a model name says whether
			// the task is even using the one somebody configured — `pickModel`
			// falls back to the first enabled model without saying so.
			completionTokens,
			reasoningTokens,
			modelKey: choice.model.modelKey,
			// What the run cost, so "it grinds" is a number rather than a report.
			// Totals across every call the run made, so the one line the panel has
			// always shown stays true now that a review makes two.
			promptChars,
			buildMs,
			modelMs,
			retried,
			survey,
			confirm
		};

		// Only advance the watermark on a pass that actually read the activity,
		// or a failed run would silently skip a day's conversation.
		if (mode === 'harvest') setSetting(WATERMARK_KEY, startedAt, userId);
		// And only claim the lattice has been reviewed once the survey has been
		// all the way round it. With a window still to come there is lattice this
		// run never looked at, and a signature saying otherwise would let a
		// scheduled review skip it.
		if (!survey?.more) setSetting(LATTICE_MARK_KEY, latticeMark, userId);

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
		// Which pass ran out, because a review has two and they fail for
		// different reasons: a slow survey is a lattice too wide for the model,
		// a slow close read is a model that cannot finish a small job.
		const where =
			stage === 'survey'
				? 'the survey of the lattice’s shape'
				: stage === 'confirm'
					? 'the close read'
					: 'the harvest';
		// What that pass was actually allowed, which is not `cfg.timeoutSeconds`
		// for a survey and is the number a person needs in order to act.
		const appliedMs = stage === 'survey' ? surveyLimit() : remaining();
		emitEvent({
			task: 'cortex-groom',
			userId,
			type: 'job',
			name: 'cortex.groom',
			status: 'error',
			durationMs: Date.now() - startedAt,
			detail: {
				trigger,
				mode,
				tidied,
				detected,
				stage,
				modelKey: choice.model.modelKey,
				appliedMs,
				error: message,
				survey,
				confirm
			}
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
				? // The limit **applied to the pass that failed**, not the setting. This
					// quoted `cfg.timeoutSeconds` while handing the survey half of it,
					// which is why a run that died at 150 seconds reported 300.
					`${where} did not answer within the ${Math.round(appliedMs / 1000)}s it was given (of the ${cfg.timeoutSeconds}s this run is allowed) — raise the time limit in Admin → Cortex, or use a faster model`
				: message,
			tidied,
			detected,
			modelKey: choice.model.modelKey,
			survey,
			confirm
		};
	}
}
