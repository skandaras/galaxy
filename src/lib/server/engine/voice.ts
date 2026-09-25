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
	'Format your replies to be read on a screen, not parsed out of a paragraph. Use short paragraphs of two or three sentences, separated by a blank line. Use a bulleted list whenever you are reporting more than one thing, such as files changed, options considered or problems found: one item per line, never as a run-on sentence. Give each bullet or section a short bold lead-in naming what it is about, so the reply can be skimmed. Use a heading only when the reply has genuinely distinct sections. Never answer with a single long paragraph.';

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
 * the reply contract. Layout is LAYOUT_TASKS' job, and the moment a rule about
 * shape appears here, that set has to shrink.
 *
 * Split into three exported constants below, and that is not decoration.
 * AGENTS.md sends contributors to this file instead of restating the rules, so
 * the prose the coding agent writes into the repository and the prose the
 * product speaks are held to one list. Two copies diverge on the first
 * addition, which is the failure this whole file is being reorganised around.
 */

/** Words that read as machine-written wherever they appear. */
export const BANNED_WORDS =
	'Prefer the plain word. Avoid "stated plainly", "honest", "honestly", "earn", "earned", ' +
	'"silently", "silent", "delve", "tapestry", "nuanced", "vibrant", "resonate", "underscore", ' +
	'"underscored", "robust", "seamless", "embark", "leverage", "utilise", "landscape", "realm", ' +
	'"navigate the complexities of", "it is worth noting that". These are padding wherever they appear.';

/**
 * Sentence shapes that promise a contrast and deliver a restatement.
 *
 * Written as templates rather than described, for the same reason the word list
 * is a list: a model can check a draft against a pattern it can match, and
 * cannot check it against "avoid formulaic phrasing".
 */
export const BANNED_FRAMINGS =
	'NEVER use these sentence shapes: "It is not X, it is Y"; "Not just X, Y"; ' +
	'"What sets X apart is"; "At its core, X is"; "Whether you are X or Y"; ' +
	'"X is not just about Y, it is about Z"; ' +
	'"Never call a statement honest or say you are being honest; just say the thing"';

/**
 * Stepping back to tell the reader that a thing has a name.
 *
 * Separate from the framings above because the sentence is well formed. What
 * gives it away is the stop to announce the label rather than use it.
 */
export const BANNED_NAMING =
	'Do not stop to name a concept for the reader: "the term was coined to describe", ' +
	'"it names something we have all felt", "the key word is", "none of this is about". ' +
	'Let the idea arrive in context, or attribute it to its source and carry on.';

export const HOUSE_VOICE = [
	'Cut straight to the answer. Do not affirm the input with "Great question", "I would be happy to ' +
		'help" or "Let me take a look". Do not restate the question before answering it. No flattery: ' +
		'"Good catch", "you are absolutely right" and "that is a really interesting point" are noise ' +
		'when true and a lie the rest of the time. Agreement is shown by acting on what was said.',
	'Hedge only where the doubt is warranted, and say what the doubt is.',
	'Do not use the em dash (—). Use a comma, a colon, brackets or a new sentence.',
	BANNED_WORDS,
	BANNED_FRAMINGS,
	BANNED_NAMING,
	'Stop when the answer stops. Do not close by summarising the reply that was just read, do not ' +
		'offer further help, and do not ask whether they would like you to continue. If there is an ' +
		'obvious next step, take it or name it in one line.'
].join('\n\n');

/**
 * The tasks whose output a person reads as prose, and the only ones the house
 * style reaches.
 *
 * Excluded, and each for its own reason:
 * - `chat-title` (two to five words) and `run-summary` (one line, no markdown) —
 *   a block this size shaping a fifteen-word output is pure cost.
 * - `visual` — the output is Mermaid or SVG.
 * - `vision` — the reader is another agent, and the output is a transcription
 *   of what is in an image. House voice would be shaping the wrong thing.
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
	'alignment-synthesis',
	'ivory-read',
	'ivory-plan',
	'ivory-synthesise',
	'ivory-redteam'
]);

/**
 * The subset of PROSE_TASKS that also gets the layout rules.
 *
 * OUTPUT_FORMAT used to be inlined into `DEFAULT_PROMPTS.chat` and `.coding`,
 * which meant it was seeded into a database row and froze at install time: the
 * one constant described as "kept as one constant so the two prompts cannot
 * drift apart" was reachable only through the mechanism that makes prompts
 * drift. Composed here it reaches every install, and a reworded rule ships with
 * no migration, which is what `houseStyle` has always done for diction.
 *
 * Narrower than PROSE_TASKS, because three of those answer with a JSON object
 * (`ux-audit`, `skill-optimiser`, `alignment-synthesis`) and a
 * paragraphs-and-bullets instruction would fight the reply contract. `subagent`
 * is out for a different reason: it answers another agent in a few sentences,
 * and headings and bold lead-ins on that are cost with no reader.
 *
 * `deep-research` is out because research.ts injects OUTPUT_FORMAT at its
 * synthesis call instead. Four other phases of that pipeline share the
 * `deep-research` prompt and answer in JSON, so the task is the wrong unit
 * there. See the comment at that call site.
 */
export const LAYOUT_TASKS: ReadonlySet<string> = new Set<(typeof CORE_TASKS)[number]>([
	'chat',
	'coding'
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
export function houseStyle(task: string): string {
	const own = styleSettings().text.trim();
	const out = [
		'',
		'',
		'[House style: how to write, not what to say. These are rules, and they apply to every reply.]',
		HOUSE_VOICE
	];
	// After the diction and before the owner, so a task that answers in prose
	// gets shape as well as sentences and the owner still overrides both.
	if (LAYOUT_TASKS.has(task)) out.push('', OUTPUT_FORMAT);
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
