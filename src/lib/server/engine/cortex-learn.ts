import {
	MIN_EFFECTIVE_WEIGHT,
	reinforce,
	type ActivationResult,
	type EdgeRef
} from '$lib/server/cortex';

/**
 * The Hebbian half: connections that get used strengthen, and the rest erode.
 *
 * The erosion lives in the store (`decayReinforcement`), because it is
 * arithmetic over a table. This module holds the harder half — deciding what
 * "used" means — and it is deliberately a narrow answer.
 *
 * **Not co-retrieval.** The obvious implementation strengthens every edge the
 * traversal crossed, which is one line inside `activate`. It is also the one
 * thing docs/CORTEX.md rules out, and for a good reason: a traversal's output is
 * a function of the weights, so reinforcing on it means the lattice grades its
 * own homework. The strongest edges get walked most, so they strengthen most,
 * and the mesh converges on whatever shape it happened to start with.
 *
 * **So: used in the answer.** A query returns concepts and, since this change,
 * the path that reached each one. When the turn finishes, the concepts the reply
 * actually named are the ones it used, and the edges that delivered *those* are
 * the ones that earned something. A concept that came back and went unmentioned
 * strengthens nothing.
 *
 * That test is a heuristic and worth saying so plainly. A reply can use a
 * concept without naming it, and it can name one in passing without leaning on
 * it. What makes it safe enough is not its accuracy but the shape of the system
 * around it: one step is 0.04 against a ceiling of 0.25, decay pulls everything
 * back continuously, and nothing here can delete a connection — the worst a run
 * of wrong guesses buys is a slightly mis-ordered result for a few weeks.
 * `messages.trace` was the other candidate signal, and it records that
 * `cortex_query` ran, never whether its answer mattered.
 */

interface Episode {
	userId: string;
	at: number;
	/** Concept id to its name, for the reply match. */
	names: Map<string, string>;
	/** Concept id to the edges that delivered it, seed first. */
	paths: Map<string, EdgeRef[]>;
}

/**
 * Kept in memory rather than in a table.
 *
 * An episode is only interesting for the seconds between a tool call and the
 * reply that call fed. Persisting it would mean a row per query, a sweep to trim
 * them, and a schema commitment to a heuristic that may well change — for a
 * value whose entire lifetime is one turn. A restart mid-turn loses the
 * reinforcement for that turn, which is the correct amount to care about it.
 */
const episodes = new Map<string, Episode>();
/** Bounded, so a long-lived process cannot accumulate these forever. */
const MAX_EPISODES = 40;
const EPISODE_TTL_MS = 30 * 60_000;
/**
 * Below this a name matches too much to mean anything. A concept called "AI" or
 * "Ops" would fire on almost any reply, and the shorter the name the more
 * confidently it does so for the wrong reason.
 */
const MIN_NAME_CHARS = 4;

function evict(now: number): void {
	for (const [key, ep] of episodes) {
		if (now - ep.at > EPISODE_TTL_MS) episodes.delete(key);
	}
	// Oldest first, which insertion order already gives us.
	while (episodes.size > MAX_EPISODES) {
		const oldest = episodes.keys().next().value;
		if (oldest === undefined) break;
		episodes.delete(oldest);
	}
}

/**
 * Remember what a query handed the agent, so the reply can be checked against
 * it. Called by `cortex_query`, keyed by the conversation it was asked in.
 *
 * Several queries in one turn merge rather than replace: an agent that asks
 * three times has three sets of concepts in front of it, and the reply may draw
 * on any of them.
 */
export function rememberActivation(
	chatId: string | null,
	userId: string,
	result: ActivationResult
): void {
	if (!chatId || !result.nodes.length) return;
	const now = Date.now();
	const prior = episodes.get(chatId);
	const names = prior?.userId === userId ? prior.names : new Map<string, string>();
	const paths = prior?.userId === userId ? prior.paths : new Map<string, EdgeRef[]>();
	for (const a of result.nodes) {
		names.set(a.node.id, a.node.name);
		const path = result.pathTo.get(a.node.id);
		// The shortest route wins where a concept came back twice: it is the one
		// that carried the most activation, so it is the one that did the work.
		if (path && (!paths.has(a.node.id) || path.length < paths.get(a.node.id)!.length)) {
			paths.set(a.node.id, path);
		}
	}
	// Re-inserted rather than mutated in place, so insertion order stays "least
	// recently touched first" and the eviction above is a plain shift.
	episodes.delete(chatId);
	episodes.set(chatId, { userId, at: now, names, paths });
	evict(now);
}

/** Drop what a conversation remembered, without learning from it. */
export function forgetActivation(chatId: string): void {
	episodes.delete(chatId);
}

/** Whole word, case-insensitive, punctuation-tolerant. */
function mentions(reply: string, name: string): boolean {
	const trimmed = name.trim();
	if (trimmed.length < MIN_NAME_CHARS) return false;
	const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`, 'iu').test(reply);
}

export interface LearnResult {
	/** Concepts the query returned and the reply went on to use. */
	used: number;
	/** Concepts it returned and the reply ignored. */
	ignored: number;
	/** Connections strengthened. */
	edges: number;
}

/**
 * Strengthen the paths to the concepts this reply actually used, then forget the
 * episode either way — a turn is judged once.
 *
 * Deliberately silent about which concepts those were. Nothing here reports to
 * the Observatory, because the Observatory is shared with admins and the rule
 * this module inherits is that no concept name ever reaches an event detail.
 */
export function learnFromReply(chatId: string, reply: string): LearnResult {
	const episode = episodes.get(chatId);
	episodes.delete(chatId);
	if (!episode || !reply.trim()) return { used: 0, ignored: 0, edges: 0 };

	const earned = new Map<string, EdgeRef>();
	let used = 0;
	for (const [id, name] of episode.names) {
		if (!mentions(reply, name)) continue;
		used++;
		for (const edge of episode.paths.get(id) ?? []) {
			earned.set(`${edge.sourceId} ${edge.targetId}`, edge);
		}
	}
	if (!used) return { used: 0, ignored: episode.names.size, edges: 0 };

	return {
		used,
		ignored: episode.names.size - used,
		edges: reinforce([...earned.values()], episode.userId)
	};
}

/** Exported for the tests, which have no business reaching into a module map. */
export const learningInternals = {
	mentions,
	size: () => episodes.size,
	clear: () => episodes.clear(),
	floor: MIN_EFFECTIVE_WEIGHT
};
