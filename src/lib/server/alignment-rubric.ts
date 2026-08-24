import { getSetting, setSetting } from '$lib/server/settings';

/**
 * The rubric the alignment agent judges against.
 *
 * Kept in code rather than in a table, deliberately. It is a document — it wants
 * to be read, reviewed and diffed, and a schema migration is the wrong shape for
 * "we reworded the definition of authenticity". Per-user tweaks (switch a
 * dimension off, weight it differently) are a preference and live in `settings`.
 *
 * Every dimension names the tradition it comes from, and the UI shows that, for
 * one reason: something measuring your character has no business being a black
 * box. If a dimension cannot be explained to the person it is applied to, it
 * should not be here.
 *
 * Bump RUBRIC_VERSION whenever the dimensions or their anchors change in a way
 * that makes old scores non-comparable. Assessments record the version they were
 * written under, so a trend line can tell "you changed" from "the ruler changed".
 *
 * 2 — the dimensions did not move, but the constitution reaching the model did:
 * every kind's two fields used to be labelled "keeping it looks like" and
 * "breaking it looks like" regardless of what the person was actually asked, so
 * a failure mode's trigger arrived as evidence of living well. Readings written
 * before this were made from mislabelled input and are not comparable with ones
 * after it.
 */
export const RUBRIC_VERSION = 2;

export interface RubricDimension {
	id: string;
	name: string;
	/** Where it comes from — shown in the UI, and half the reason to trust it. */
	tradition: string;
	/** What the dimension is actually asking. */
	definition: string;
	/** What the agent should be looking for in the text. */
	evidence: string;
	/** Behaviourally anchored scale. Index 0 is a score of 1. */
	anchors: [string, string, string, string, string];
	defaultWeight: number;
	/**
	 * A few are off unless asked for: they are sharper instruments, and having
	 * twelve dimensions fire on every short entry produces noise, not insight.
	 */
	enabledByDefault: boolean;
}

export const RUBRIC_DIMENSIONS: RubricDimension[] = [
	{
		id: 'second-order-endorsement',
		name: 'Acting on what you endorse',
		tradition: 'Frankfurt — hierarchy of desires',
		definition:
			'Whether the wants you acted on are the wants you actually stand behind. A person is most themselves when their first-order desires and their considered second-order volitions point the same way; the gap between "what I wanted" and "what I want to want" is the gap this measures.',
		evidence:
			'Look for the desire that drove the action and whether the entry endorses it on reflection. Wholeheartedness reads differently from being carried along.',
		anchors: [
			'Acted on an impulse they explicitly disown, with no sign of noticing.',
			'Acted against their considered wants and noticed only afterwards.',
			'Mixed: part of the action was endorsed, part was drift.',
			'Acted on wants they stand behind, with some friction.',
			'Wholehearted — the want and the endorsement of it were the same thing.'
		],
		defaultWeight: 3,
		enabledByDefault: true
	},
	{
		id: 'practical-judgment',
		name: 'Judgment in the particular case',
		tradition: 'Aristotle — phronesis',
		definition:
			'Whether they read this specific situation well, rather than applying a rule blindly or abandoning their values under pressure. Character is a disposition shown in particulars, and phronesis is the capacity to see which of your commitments this moment actually calls for.',
		evidence:
			'How the situation was perceived before it was acted on. Attention to the particulars, and whether the response fitted them.',
		anchors: [
			'Misread the situation entirely, or never looked at it.',
			'Applied a rule mechanically where the case called for judgment.',
			'Read it partly; acted on the obvious feature and missed the rest.',
			'Saw what the situation called for and mostly responded to it.',
			'Read the particulars precisely and found the response that fitted them.'
		],
		defaultWeight: 3,
		enabledByDefault: true
	},
	{
		id: 'locus-of-judgment',
		name: 'What you held yourself to',
		tradition: 'Stoicism — the dichotomy of control',
		definition:
			'Whether they judged themselves on their own choices and effort, or on outcomes that were never theirs to decide. Not a counsel of detachment: the point is that self-assessment aimed at the uncontrollable is both unfair and useless.',
		evidence:
			'What the entry treats as the measure of how it went. Look for self-blame attached to other people\'s reactions, luck, or results.',
		anchors: [
			'Judged themselves entirely on outcomes outside their control.',
			'Mostly outcome-focused; effort and intention barely appear.',
			'Mixed — some ownership of choices, some blaming of results.',
			'Largely judged their own choices, with occasional slippage.',
			'Cleanly separated what was theirs to decide from what was not.'
		],
		defaultWeight: 2,
		enabledByDefault: true
	},
	{
		id: 'authenticity',
		name: 'Yours, or the script',
		tradition: 'Sartre, Kierkegaard — bad faith and authenticity',
		definition:
			'Whether they acted from their own values or from an inherited role, an audience, or a story about having no choice. Bad faith is the specific move of denying your own freedom — "I had to", "that\'s just how it is" — to avoid owning a choice you did in fact make.',
		evidence:
			'Language that removes the self as the agent. Appeals to what one does, what was expected, what there was no choice about.',
		anchors: [
			'Denied having any choice where a choice plainly existed.',
			'Acted mainly to satisfy an audience or a role, unexamined.',
			'Some of it theirs, some of it inherited without inspection.',
			'Owned the choice, with a little deference to expectation.',
			'Acted from their own values and owned the freedom to do otherwise.'
		],
		defaultWeight: 3,
		enabledByDefault: true
	},
	{
		id: 'narrative-coherence',
		name: 'Fits the life you say you\'re living',
		tradition: 'MacIntyre — the narrative unity of a life',
		definition:
			'Whether this episode belongs to the story they say they are in. A life is intelligible as a whole; an action that cannot be placed in that whole is worth noticing, whether it is a lapse or the beginning of a different story.',
		evidence:
			'How the episode relates to the longer arc named in the constitution — the roles, aspirations and commitments they say they are living out.',
		anchors: [
			'Belongs to a different life entirely; nothing connects it.',
			'Hard to place in the story they describe.',
			'Fits loosely — neither continuous nor contradictory.',
			'Continuous with the arc, a recognisable chapter of it.',
			'Advances the story they say they are living, visibly.'
		],
		defaultWeight: 2,
		enabledByDefault: true
	},
	{
		id: 'motivation-quality',
		name: 'Where the motivation came from',
		tradition: 'Deci & Ryan — self-determination theory',
		definition:
			'Whether the action came from motivation they have internalised, or from guilt, obligation, image or reward. The distinction matters because controlled motivation predicts both worse persistence and a worse relationship with the value itself, even when the behaviour looks identical.',
		evidence:
			'The reason given for acting. "Because I should" and "because I wanted to be the kind of person who does" are different findings.',
		anchors: [
			'Entirely external — reward, punishment, or being seen to.',
			'Driven by guilt or "should", with no ownership.',
			'Part obligation, part genuine.',
			'Largely internalised; the value is theirs.',
			'Fully autonomous — done because it expresses who they are.'
		],
		defaultWeight: 3,
		enabledByDefault: true
	},
	{
		id: 'value-conflict',
		name: 'How you handled the collision',
		tradition: 'Schwartz — the structure of basic values',
		definition:
			'When two of their values genuinely pulled against each other, whether they saw it and chose, or let one quietly win. Real value systems contain structural conflicts — openness against conservation, self-transcendence against self-enhancement — and maturity is choosing among them knowingly, not pretending they agree.',
		evidence:
			'Two principles both bearing on the same decision. Whether the entry acknowledges the trade-off or reports only the winner.',
		anchors: [
			'A real conflict was denied or never noticed.',
			'One value won by default; the cost went unacknowledged.',
			'The conflict was seen but not really weighed.',
			'Chose deliberately and named what it cost.',
			'Chose deliberately, named the cost, and honoured the losing value where it could.'
		],
		defaultWeight: 3,
		enabledByDefault: true
	},
	{
		id: 'moral-disengagement',
		name: 'Disengagement mechanisms',
		tradition: 'Bandura — moral disengagement',
		definition:
			'Whether the entry uses any of the eight mechanisms that let a person act against their own standards without feeling they have: euphemistic labelling, moral justification, advantageous comparison, displacement or diffusion of responsibility, distortion of consequences, dehumanisation, and attribution of blame to the victim.',
		evidence:
			'These live in word choice, and are the most reliably detectable thing in the rubric. Name the specific mechanism and quote the phrase carrying it.',
		anchors: [
			'Several mechanisms doing heavy work throughout.',
			'A mechanism clearly carrying the justification.',
			'Traces — softened language around the uncomfortable part.',
			'Largely absent; the account stays honest about what happened.',
			'Names their own conduct plainly, including where it was poor.'
		],
		defaultWeight: 4,
		enabledByDefault: true
	},
	{
		id: 'rationalisation',
		name: 'Resolved or explained away',
		tradition: 'Festinger — cognitive dissonance',
		definition:
			'Whether a gap between conduct and values was actually resolved, or dissolved by adjusting the belief until the discomfort stopped. Dissonance reduction is not the same as integrity, and it is much more comfortable.',
		evidence:
			'A value quietly restated to fit what was done. Reasoning that appears after the action and conveniently exonerates it.',
		anchors: [
			'The value was rewritten to fit the behaviour.',
			'Elaborate justification arriving after the fact.',
			'Some genuine reckoning mixed with some explaining away.',
			'Sat with the discomfort rather than resolving it cheaply.',
			'Named the gap plainly and left it standing as a gap.'
		],
		defaultWeight: 3,
		enabledByDefault: true
	},
	{
		id: 'reflective-quality',
		name: 'Quality of the reflection',
		tradition: 'Fonagy — reflective functioning / mentalization',
		definition:
			'Whether they can hold their own mental states and other people\'s in view at once, with appropriate uncertainty. This measures the reflecting rather than the conduct — an honest, mentalizing account of a bad day is worth more than a polished account of a good one.',
		evidence:
			'Other people appearing as minds with their own reasons, not as obstacles or scenery. Uncertainty held rather than resolved prematurely.',
		anchors: [
			'No inner life described — events only, or others as scenery.',
			'Own feelings named; other minds absent or assumed.',
			'Some genuine reflection, some narration of events.',
			'Holds their own and others\' states, with real uncertainty.',
			'Genuine insight into why they and others acted as they did.'
		],
		defaultWeight: 3,
		enabledByDefault: true
	},
	{
		id: 'self-compassion',
		name: 'Honest and kind',
		tradition: 'Neff — self-compassion',
		definition:
			'Whether they can look at their own failure without either flinching from it or attacking themselves for it. Self-kindness rather than self-judgment, common humanity rather than isolation, mindful awareness rather than over-identification. Harshness is not rigour — it reliably produces less change, not more.',
		evidence:
			'The tone taken towards themselves about a failure. Contempt and evasion are both findings; so is plain, unsparing kindness.',
		anchors: [
			'Contemptuous self-attack, or total evasion of the failure.',
			'Harsh with themselves in a way that obscures what happened.',
			'Honest but cold, or kind but not quite honest.',
			'Faced it squarely and without cruelty.',
			'Unsparing about the conduct and decent to the person — both at once.'
		],
		defaultWeight: 3,
		enabledByDefault: true
	},
	{
		id: 'role-fidelity',
		name: 'The roles you named',
		tradition: 'Confucian role ethics',
		definition:
			'Whether they met the obligations of the specific roles they wrote down — parent, partner, colleague, friend. The self here is constituted by its relationships rather than standing behind them, so this asks about duties owed to particular people, not about virtue in the abstract.',
		evidence:
			'Only scored when a role from the constitution is actually in play in the entry. Judge against what they said that role obliges.',
		anchors: [
			'Acted against the role\'s obligations as they defined them.',
			'The role was neglected where it was clearly in play.',
			'Met the letter of it, not much more.',
			'Met the obligations they named for that role.',
			'Met them fully, including the parts nobody would have noticed.'
		],
		defaultWeight: 3,
		enabledByDefault: true
	}
];

export const RUBRIC_BY_ID = new Map(RUBRIC_DIMENSIONS.map((d) => [d.id, d]));

/** Bandura's eight, so the UI can label what the agent reports. */
export const DISENGAGEMENT_MECHANISMS: Record<string, string> = {
	'moral-justification': 'Moral justification',
	'euphemistic-labelling': 'Euphemistic labelling',
	'advantageous-comparison': 'Advantageous comparison',
	'displacement-of-responsibility': 'Displacement of responsibility',
	'diffusion-of-responsibility': 'Diffusion of responsibility',
	'distortion-of-consequences': 'Distortion of consequences',
	dehumanisation: 'Dehumanisation',
	'attribution-of-blame': 'Attribution of blame'
};

export interface RubricPrefs {
	/** Dimension ids switched off for this person. */
	disabled: string[];
	/** Per-dimension weight overrides; anything absent uses defaultWeight. */
	weights: Record<string, number>;
}

export const DEFAULT_RUBRIC_PREFS: RubricPrefs = { disabled: [], weights: {} };

const RUBRIC_PREFS_KEY = 'alignment.rubric';

export function getRubricPrefs(userId: string): RubricPrefs {
	return normaliseRubricPrefs(getSetting<RubricPrefs>(RUBRIC_PREFS_KEY, DEFAULT_RUBRIC_PREFS, userId));
}

export function setRubricPrefs(userId: string, prefs: Partial<RubricPrefs>): RubricPrefs {
	const clean = normaliseRubricPrefs(prefs);
	setSetting(RUBRIC_PREFS_KEY, clean, userId);
	return clean;
}

/**
 * Drop unknown ids and clamp weights.
 *
 * The route stores what it is handed, so without this a raw PUT could disable a
 * dimension that no longer exists (harmless) or set a weight of 900 (not).
 */
export function normaliseRubricPrefs(raw: Partial<RubricPrefs> | null | undefined): RubricPrefs {
	const disabled = Array.isArray(raw?.disabled)
		? [...new Set(raw.disabled.filter((id) => RUBRIC_BY_ID.has(id)))]
		: [];
	const weights: Record<string, number> = {};
	for (const [id, value] of Object.entries(raw?.weights ?? {})) {
		if (!RUBRIC_BY_ID.has(id)) continue;
		const n = Number(value);
		if (!Number.isFinite(n)) continue;
		weights[id] = Math.min(5, Math.max(1, Math.round(n)));
	}
	return { disabled, weights };
}

export interface ActiveDimension extends RubricDimension {
	weight: number;
}

/** The dimensions this person is actually judged on, with effective weights. */
export function activeDimensions(userId: string): ActiveDimension[] {
	const prefs = getRubricPrefs(userId);
	const off = new Set(prefs.disabled);
	return RUBRIC_DIMENSIONS.filter((d) => (off.has(d.id) ? false : d.enabledByDefault || prefs.weights[d.id] !== undefined))
		.map((d) => ({ ...d, weight: prefs.weights[d.id] ?? d.defaultWeight }));
}

/**
 * The rubric as the model sees it.
 *
 * Anchors are included in full: a bare 1–5 scale invites the model to invent its
 * own idea of what a 4 means, and the whole value of a behaviourally anchored
 * scale is that it does not have to.
 */
export function rubricForPrompt(dimensions: ActiveDimension[]): string {
	return dimensions
		.map((d) =>
			[
				`### ${d.id} — ${d.name} (weight ${d.weight})`,
				`Tradition: ${d.tradition}`,
				d.definition,
				`Evidence to look for: ${d.evidence}`,
				'Anchors:',
				...d.anchors.map((a, i) => `  ${i + 1}. ${a}`)
			].join('\n')
		)
		.join('\n\n');
}
