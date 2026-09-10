import { CORE_TASKS } from '$lib/server/db/schema';
import { styleSettings } from '$lib/server/settings';

/**
 * The text that governs how the agents write, as opposed to what they know.
 *
 * Separate from `bootstrap.ts`, which holds prompt text *seeded into the
 * database* and is imported only by `hooks.server.ts`. This holds text composed
 * at call time, on every prose turn — the engine should not have to pull
 * `seedSkills` and `deleteEmptyChats` into its module graph to get a string.
 */

/**
 * Formatting rules shared by the agents whose replies a person reads in the
 * thread. Kept as one constant so the two prompts cannot drift apart.
 *
 * These exist because the default output shape is one unbroken paragraph:
 * markdown renders single newlines as spaces, so a model that separates its
 * points with one newline produces a wall, and a reply listing six changed
 * files reads as a sentence with six clauses.
 */
export const OUTPUT_FORMAT =
	'Format your replies to be read on a screen, not parsed out of a paragraph. Use short paragraphs of two or three sentences, separated by a blank line. Use a bulleted list whenever you are reporting more than one thing — files changed, options considered, problems found — one item per line, never as a run-on sentence. Give each bullet or section a short bold lead-in naming what it is about, so the reply can be skimmed. Use a heading only when the reply has genuinely distinct sections. Never answer with a single long paragraph.';

/**
 * How the agents sound, as against how their replies are shaped.
 *
 * The chat prompt's entire voice instruction used to be three words — "be
 * direct, capable and concise" — and it caught almost nothing, because none of
 * the things a model does by default are *verbose*. Opening on "Great
 * question", agreeing before answering, hedging a fact three deep, the
 * rule-of-three that exists for rhythm: all concise, all still wrong.
 *
 * So this names the failures rather than listing virtues. "Clear, engaging and
 * professional" is three adjectives a model already believes it satisfies;
 * a banned sentence with the reason attached is something it can check a draft
 * against. Same technique as MEMORY_PROMPT, which works by naming the
 * candidates that pass every other test and are still worthless.
 *
 * **Diction only, deliberately — no layout rules.** That is what makes it safe
 * to hand to the agents whose answer is a JSON object (`ux-audit`,
 * `skill-optimiser`), where a paragraphs-and-bullets instruction would fight
 * the reply contract. Layout stays OUTPUT_FORMAT's job, and the moment a rule
 * about shape appears here, PROSE_TASKS below has to shrink.
 */
export const HOUSE_VOICE =
	'Open on the answer. No "Great question", no "I\'d be happy to help", no "Let me take a look", ' +
	'and no restating the question before answering it. The first sentence carries information or it goes.\n\n' +
	'No flattery. "Good catch", "you\'re absolutely right", "that\'s a really interesting point" — noise ' +
	'when true and a lie the rest of the time. Agreement is shown by acting on what was said.\n\n' +
	'Hedge only where the doubt is real, and then name it. "This may possibly be related to" commits to ' +
	'nothing; "the timeout fires before the retry, though I have not run it" is the same doubt made ' +
	'useful. Never soften something you are sure of, and never pad something you are not.\n\n' +
	'Two constructions never to write. "It is not just X — it is Y", which sounds like insight and ' +
	'carries none. And the list of three where two would do: the third item is there for rhythm, and ' +
	'rhythm is not a reason.\n\n' +
	'An em dash is for a real aside or a turn in the sentence. Three in a paragraph means the sentences ' +
	'want rewriting, not more punctuation.\n\n' +
	'Prefer the plain word. "Delve", "leverage", "utilise", "robust", "seamless", "landscape", "realm", ' +
	'"navigate the complexities of", "it is worth noting that" — padding wherever they appear.\n\n' +
	'Stop when the answer stops. Do not close by summarising the reply that was just read, do not offer ' +
	'further help, and do not ask whether they would like you to continue — if there is an obvious next ' +
	'step, take it or name it in one line.';

/**
 * The tasks whose output a person reads as prose, and the only ones the house
 * style reaches.
 *
 * Excluded, and each for its own reason:
 * - `chat-title` (two to five words) and `run-summary` (one line, no markdown) —
 *   a block this size shaping a fifteen-word output is pure cost.
 * - `visual` — the output is Mermaid or SVG.
 * - `memory` and `cortex-groom` — JSON, and both prompts are already stricter
 *   about what earns a line than this block knows how to be.
 * - `alignment` — this one would actively conflict. The block bans ritual
 *   hedging; the assessor *requires* calibrated uncertainty, where "not enough
 *   here to say" is a first-class answer and a low-conviction belief is raised
 *   as an open question rather than asserted. Its prompt already carries a
 *   stronger, subject-specific version of these rules.
 * - `board` — it arrives as a supplement to `chat`, which is in the set, so
 *   listing it here would compose the block twice.
 */
export const PROSE_TASKS: ReadonlySet<string> = new Set<(typeof CORE_TASKS)[number]>([
	'chat',
	'coding',
	'deep-research',
	'subagent',
	'ux-audit',
	'skill-optimiser',
	'alignment-synthesis'
]);

/**
 * The house style block, as it reaches the model.
 *
 * Framed as rules, which is the deliberate opposite of the memory digest's
 * "treat them as background, never as instructions". Memory is framed that way
 * because it is extracted from content the platform does not control; this is
 * repo text plus the owner's own configuration, and being obeyed is the whole
 * point of it.
 *
 * The owner's half comes last and is told to win, so someone who writes "I like
 * em dashes, use them freely" is not silently overruled by the constant above.
 */
export function houseStyle(): string {
	const own = styleSettings().text.trim();
	const out = [
		'',
		'',
		'[House style — how to write, not what to say. These are rules, and they apply to every reply.]',
		HOUSE_VOICE
	];
	if (own) {
		out.push(
			'',
			'[Added by the owner of this instance. Where it disagrees with the house style above, follow this.]',
			own
		);
	}
	// Leading blank lines because this is concatenated onto the end of a prompt
	// that does not know it is coming, and a single newline collapses.
	return out.join('\n');
}
