import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { cortexAssociations, cortexNodes, cortexProposals } from '$lib/server/db/schema';
import {
	circuitIndex,
	deleteAssociation,
	deleteNode,
	findNodeByName,
	getNode,
	listAssociations,
	listNodes,
	logChange,
	seedNodes,
	mergeNodes,
	saveAssociation,
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
}

export function detect(userId: string): Detected[] {
	const nodes = listNodes(userId).filter((n) => n.ownerId === userId || n.ownerId === null);
	const edges = visibleEdges(userId);
	const degree = new Map<string, number>();
	for (const e of edges) {
		degree.set(e.sourceId, (degree.get(e.sourceId) ?? 0) + 1);
		degree.set(e.targetId, (degree.get(e.targetId) ?? 0) + 1);
	}

	const out: Detected[] = [];

	for (const node of nodes) {
		if (degree.get(node.id)) continue;
		out.push({
			kind: 'connect',
			title: `"${node.name}" connects to nothing`,
			rationale:
				'Traversal can only reach a concept through a connection, so this one cannot surface in any query. Connect it to whatever it relates to, or remove it.',
			node: node.id
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

	for (const node of nodes) {
		if (node.circuits?.length) continue;
		out.push({
			kind: 'circuit',
			title: `"${node.name}" is not filed under an area`,
			rationale:
				'The context index agents see is grouped by area, so an unfiled concept is invisible in it however well connected it is.',
			node: node.id
		});
	}

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
			target: d.target
		})),
		max
	);
}

// --- proposals --------------------------------------------------------------

export function listProposals(userId: string, status: 'open' | 'all' = 'open') {
	const where =
		status === 'open'
			? and(eq(cortexProposals.userId, userId), eq(cortexProposals.status, 'open'))
			: eq(cortexProposals.userId, userId);
	return db
		.select()
		.from(cortexProposals)
		.where(where)
		.orderBy(desc(cortexProposals.createdAt), cortexProposals.id)
		.all();
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
export function applyProposal(id: string, userId: string): boolean {
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
	if (!p) return false;

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
				if (!p.nodeId || !p.targetId) return false;
				if (!mergeNodes(p.nodeId, p.targetId, userId, 'groom')) return false;
				break;
			}
			case 'connect': {
				if (!p.nodeId || !p.targetId) return false;
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
				if (!p.nodeId || !p.targetId) return false;
				if (!deleteAssociation(p.nodeId, p.targetId, userId, 'groom')) return false;
				break;
			}
			case 'weight': {
				if (!p.nodeId || !p.targetId || num(payload.weight) === undefined) return false;
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
				if (!p.nodeId) return false;
				const node = getNode(p.nodeId, userId);
				if (!node) return false;
				saveNode({
					id: node.id,
					name: p.kind === 'rename' ? (str(payload.name) ?? node.name) : node.name,
					ownerId: userId,
					circuits: Array.isArray(payload.areas) ? payload.areas.map(String) : undefined,
					isConvergence:
						p.kind === 'convergence' ? payload.isConvergence !== false : undefined,
					actor: 'groom',
					runId
				});
				break;
			}
			case 'delete': {
				if (!p.nodeId) return false;
				if (!deleteNode(p.nodeId, userId, 'groom')) return false;
				break;
			}
			default:
				return false;
		}
	} catch {
		// A concept gone since the suggestion was raised, or the cap reached.
		// Leave it open: a half-applied change nobody was told about is worse
		// than one that plainly did not happen.
		return false;
	}

	db.update(cortexProposals)
		.set({ status: 'actioned', decidedAt: new Date() })
		.where(eq(cortexProposals.id, id))
		.run();
	return true;
}

export function decideProposal(
	id: string,
	userId: string,
	status: 'actioned' | 'discarded'
): boolean {
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
	return res.changes > 0;
}

/**
 * File this run's suggestions, dropping anything already decided.
 *
 * The fingerprint check spans every status, not just open ones: something
 * accepted is done, and something turned down was considered and declined.
 * Re-raising either is how a review queue teaches people to stop reading it.
 */
export function recordProposals(
	userId: string,
	raw: unknown[],
	max: number
): { added: number; duplicates: number } {
	const known = new Set(
		db
			.select({ fingerprint: cortexProposals.fingerprint })
			.from(cortexProposals)
			.where(eq(cortexProposals.userId, userId))
			.all()
			.map((r) => r.fingerprint)
	);
	const visible = new Set(listNodes(userId).map((n) => n.id));
	let added = 0;
	let duplicates = 0;

	for (const item of raw.slice(0, max)) {
		const p = (item ?? {}) as Record<string, unknown>;
		const kind = String(p.kind ?? '');
		const title = String(p.title ?? '').trim();
		if (!title || !KINDS.includes(kind as Kind)) continue;

		const nodeId = typeof p.node === 'string' ? p.node : null;
		const targetId = typeof p.target === 'string' ? p.target : null;
		// A proposal naming a node this person cannot see is either a model
		// hallucination or a boundary crossing. Neither is worth filing.
		// `create` is the exception by definition: its concept does not exist yet.
		if (kind !== 'create') {
			if (nodeId && !visible.has(nodeId)) continue;
			if (targetId && !visible.has(targetId)) continue;
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
				payload: (p.payload ?? null) as unknown,
				fingerprint: fp,
				status: 'open',
				createdAt: new Date()
			})
			.run();
		added++;
	}
	return { added, duplicates };
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
					'Nothing worth adding is a fine answer. Reply with an empty array.'
				].join(' ')
			: [
					`Suggest at most ${max} changes that would make this lattice better at answering questions about its owner.`,
					'Look for: near-duplicate concepts that should be merged; clusters with no connection leaving them, which add nothing plain search would not already find; obvious missing connections between concepts that clearly relate; concepts bridging several areas that are not marked as bridges.',
					'Orphans, duplicate names and unfiled concepts are already found without you — do not spend suggestions on them unless you can say something the check could not.'
				].join(' ');

	return [
		mode === 'harvest'
			? `--- WHAT HAS HAPPENED SINCE THE LAST PASS ---\n${activity || '(nothing new)'}`
			: '--- A FULL REVIEW OF THE LATTICE ---',
		`--- THE LATTICE (${nodes.length} concepts) ---`,
		lattice,
		`--- AREAS ---`,
		circuits.map((c) => `- ${c.id} "${c.name}" (${c.count})`).join('\n') || '(none defined)',
		`unfiled concepts: ${unfiled}`,
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
			'create   — payload {"name":"…","description":"…","connect":[{"node":"node-id","weight":0.7,"why":"…"}]}. Connections are part of the suggestion, not a follow-up: a concept nothing links to can never surface in a query.',
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
	const detected = recordDetected(userId, detect(userId), max).added;
	setSetting(LAST_RUN_KEY, Date.now(), userId);

	const nodes = listNodes(userId);
	const watermark = getSetting<number>(WATERMARK_KEY, 0, userId);
	const activity = mode === 'harvest' ? gatherActivity(userId, watermark).text : '';
	// Counts plus the newest edit: enough to notice a concept added, removed or
	// rewritten since the last pass.
	const latticeMark = `${nodes.length}:${visibleEdges(userId).length}:${nodes.reduce(
		(m, n) => Math.max(m, n.updatedAt?.getTime() ?? 0),
		0
	)}`;

	if (mode === 'harvest' && !activity.trim() && getSetting<string>(LATTICE_MARK_KEY, '', userId) === latticeMark) {
		// Nothing said and nothing changed, so there is nothing for a model to
		// read. Skipping the call outright is what makes a daily — or hourly —
		// cadence affordable: a quiet day costs nothing at all.
		return { ran: false, mode, reason: 'nothing new since the last pass', tidied, detected };
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
		const { text, usage } = await choice.adapter.complete(
			{
				modelKey: choice.model.modelKey,
				messages: [
					{ role: 'system', content: taskCfg?.systemPrompt ?? '' },
					{ role: 'user', content: buildGroomPrompt(userId, max, mode, activity) }
				],
				maxTokens: 4096
			},
			AbortSignal.timeout(180_000)
		);
		logUsage('cortex-groom', choice.model.modelKey, usage, 'ok', userId);

		// `.proposals`, not the parsed value itself: extractJson returns an object
		// by construction, so a prompt asking for a bare array gets nothing back
		// however well the model complied. See json.ts.
		const parsed = extractJson(text);
		const proposals = Array.isArray(parsed?.proposals) ? parsed.proposals : [];
		const { added, duplicates } = recordProposals(userId, proposals, max);

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
			detail: { trigger, mode, tidied, detected, proposed: added, duplicates, concepts: nodes.length }
		});
		return { ran: true, mode, tidied, detected, proposed: added, duplicates };
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
