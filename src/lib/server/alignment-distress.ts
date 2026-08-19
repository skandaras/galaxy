/**
 * A floor under the care path, not a filter.
 *
 * The prompt already instructs the agent to drop the rubric and respond with
 * care when an entry shows real distress. This exists because "the model was
 * asked to" is not good enough for this one case: a model that misses it
 * returns a tidy little scorecard about someone's worst night, which is the
 * single worst thing this feature could do.
 *
 * So there are two independent mechanisms. This one is deliberately small and
 * high-precision — it fires on unambiguous phrasing only. Its job is not to
 * detect distress reliably (nothing here could) but to make the failure
 * one-sided: when it fires, the care response is shown whatever the model
 * decided, and the rubric result is suppressed. It never suppresses the model's
 * own care judgement, only ever adds to it.
 *
 * Deliberately not exhaustive and deliberately not clever. A longer list would
 * catch a novelist describing a character and turn a journal into something
 * that flinches.
 */

/**
 * Phrases that carry intent or hopelessness about oneself in ordinary English.
 * Kept to constructions that are hard to read any other way — "kill myself"
 * rather than "kill", "want to die" rather than "die".
 */
const SIGNALS = [
	'kill myself',
	'killing myself',
	'end my life',
	'ending my life',
	'take my own life',
	'want to die',
	'wish i was dead',
	'wish i were dead',
	"don't want to be here anymore",
	'dont want to be here anymore',
	'better off without me',
	'no reason to go on',
	'no point going on',
	'hurt myself',
	'hurting myself',
	'harm myself',
	'self harm',
	'self-harm',
	'suicidal',
	'suicide'
];

/**
 * Negations and distancing that make a signal something other than a statement
 * about the writer's own present state. Crude on purpose — this only downgrades
 * an already-crude match, and getting it wrong costs a gentle message nobody
 * needed rather than a missed one.
 */
const DISTANCERS = [
	'not suicidal',
	"i'm not suicidal",
	'im not suicidal',
	'never suicidal',
	'suicide prevention',
	'suicide hotline',
	'suicide rates',
	'in the film',
	'in the book',
	'the character',
	'the article',
	'the documentary'
];

export interface DistressCheck {
	flagged: boolean;
	/** The matched phrase, for the event detail. Never the surrounding text. */
	signal?: string;
}

export function checkDistress(text: string): DistressCheck {
	const lower = text.toLowerCase();
	if (DISTANCERS.some((d) => lower.includes(d))) return { flagged: false };
	const signal = SIGNALS.find((s) => lower.includes(s));
	return signal ? { flagged: true, signal } : { flagged: false };
}

/**
 * What the agent is told when the pre-screen fires, appended to the prompt.
 * Phrased as a floor rather than a conclusion so a false positive does not force
 * a strange response to an ordinary entry.
 */
export const DISTRESS_PROMPT_NOTE =
	'A conservative pre-screen flagged possible distress in this entry. Read it yourself and decide. If there is any real distress here, set "care": true and follow the care instructions exactly — no scores, no rubric. If the phrase was incidental (quoting something, describing a film, saying they are *not* struggling), assess it normally and set "care": false.';

/**
 * The message shown when the pre-screen fired but the model returned a normal
 * assessment anyway. Deliberately short, and deliberately not a crisis script:
 * it points at people rather than at the tool, and does not name a specific
 * hotline because this is self-hosted and could be running anywhere.
 */
export const CARE_FALLBACK =
	'Something in this entry sounded heavy, so I have set the rubric aside — a scorecard is not what this moment calls for.\n\nIf you are struggling, please talk to someone you trust, or a crisis line where you are. This tool is a mirror for ordinary reflection; it is not equipped for this, and you deserve better than it can give.';
