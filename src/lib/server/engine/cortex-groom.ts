import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { cortexAssociations, cortexNodes, cortexProposals } from '$lib/server/db/schema';
import {
	circuitIndex,
	listAssociations,
	listNodes,
	logChange,
	syncFts,
	visibleEdges,
	type CortexNode
} from '$lib/server/cortex';
import { listMemoryItems } from './memory';
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

export interface GroomResult {
	ran: boolean;
	reason?: string;
	tidied?: number;
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
	return { lastRun: getSetting<number>(LAST_RUN_KEY, 0, userId) };
}

/** Stable enough that the same suggestion is recognised on a later run. */
export function fingerprint(kind: string, ...parts: string[]): string {
	return [kind, ...parts.map((p) => p.trim().toLowerCase())].filter(Boolean).join('|').slice(0, 300);
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

export function decideProposal(
	id: string,
	userId: string,
	status: 'actioned' | 'discarded'
): boolean {
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
		if (nodeId && !visible.has(nodeId)) continue;
		if (targetId && !visible.has(targetId)) continue;

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

export function buildGroomPrompt(userId: string, max: number): string {
	const nodes = listNodes(userId);
	const { circuits, unfiled } = circuitIndex(userId);
	const decided = db
		.select({ title: cortexProposals.title, status: cortexProposals.status })
		.from(cortexProposals)
		.where(eq(cortexProposals.userId, userId))
		.all()
		.map((p) => `- [${p.status}] ${p.title}`)
		.slice(0, 200);

	return [
		`--- THE LATTICE (${nodes.length} concepts) ---`,
		nodes.map((n) => describeNode(n, userId)).join('\n'),
		`--- AREAS ---`,
		circuits.map((c) => `- ${c.id} "${c.name}" (${c.count})`).join('\n') || '(none defined)',
		`unfiled concepts: ${unfiled}`,
		// Read-only, and one-directional: the groomer may notice that a recorded
		// observation implies a concept, and never writes back to memory.
		`--- RECORDED OBSERVATIONS (for spotting concepts that are missing; never edit these) ---`,
		listMemoryItems(userId)
			.filter((m) => m.status === 'active')
			.slice(0, 60)
			.map((m) => `- (${m.kind}) ${m.content}`)
			.join('\n') || '(none)',
		`--- ALREADY DECIDED (do not raise again) ---`,
		decided.join('\n') || '(nothing yet)',
		`--- YOUR TASK ---`,
		`Suggest at most ${max} changes that would make this lattice better at answering questions about its owner.`,
		'Look for: near-duplicate concepts that should be merged; concepts that connect to nothing and so can never surface; clusters with no connection leaving them; obvious missing connections between concepts that clearly relate; concepts that bridge several areas and are not marked as bridges; unfiled concepts that belong to an existing area.',
		'Reply with ONLY a JSON array. Each item: {"kind":"merge|connect|disconnect|weight|circuit|convergence|rename|delete","title":"one line","rationale":"why","node":"node-id","target":"node-id or area-id, if the change involves two things","payload":{}}',
		'Use the exact ids given above. Propose nothing you cannot justify from what you were shown.'
	].join('\n\n');
}

// --- the run ----------------------------------------------------------------

export async function runCortexGroom(
	trigger: 'schedule' | 'manual',
	userId: string
): Promise<GroomResult> {
	const cfg = groomSettings();
	const runId = randomUUID();

	// Tidying is deterministic and free, so it happens whether or not there is a
	// model to do the thinking half.
	const tidied = tidy(userId, runId);
	setSetting(LAST_RUN_KEY, Date.now(), userId);

	if (getBudgetStatus().blocked) {
		emitEvent({
			task: 'cortex-groom',
			userId,
			type: 'job',
			name: 'cortex.groom',
			status: 'error',
			detail: { trigger, tidied, skipped: true, reason: 'budget cap reached' }
		});
		return { ran: false, reason: 'budget cap reached', tidied };
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
			detail: { trigger, tidied, reason: 'no model configured' }
		});
		return { ran: false, reason: 'no model configured', tidied };
	}

	const nodes = listNodes(userId);
	if (nodes.length < 3) {
		return { ran: false, reason: 'too few concepts to groom', tidied };
	}

	const startedAt = Date.now();
	try {
		const max = Math.max(1, Math.min(cfg.maxProposalsPerRun, 25));
		const { text, usage } = await choice.adapter.complete(
			{
				modelKey: choice.model.modelKey,
				messages: [
					{ role: 'system', content: taskCfg?.systemPrompt ?? '' },
					{ role: 'user', content: buildGroomPrompt(userId, max) }
				],
				maxTokens: 4096
			},
			AbortSignal.timeout(180_000)
		);
		logUsage('cortex-groom', choice.model.modelKey, usage, 'ok', userId);

		const parsed = extractJson(text);
		const proposals = Array.isArray(parsed) ? parsed : [];
		const { added, duplicates } = recordProposals(userId, proposals, max);

		emitEvent({
			task: 'cortex-groom',
			userId,
			type: 'job',
			name: 'cortex.groom',
			status: 'ok',
			durationMs: Date.now() - startedAt,
			// Counts only. Concept names never reach an event detail.
			detail: { trigger, tidied, proposed: added, duplicates, concepts: nodes.length }
		});
		return { ran: true, tidied, proposed: added, duplicates };
	} catch (err) {
		emitEvent({
			task: 'cortex-groom',
			userId,
			type: 'job',
			name: 'cortex.groom',
			status: 'error',
			durationMs: Date.now() - startedAt,
			detail: { trigger, tidied, error: err instanceof Error ? err.message : String(err) }
		});
		return { ran: false, reason: 'model call failed', tidied };
	}
}
