/**
 * Shapes and labels shared by the Alignment API and its UI.
 *
 * Mirrors board-types.ts: the server owns the tables, this owns the vocabulary
 * both sides speak, so a kind added here cannot be half-added.
 */

export const PRINCIPLE_KINDS = [
	'value',
	'principle',
	'belief',
	'role',
	'failure-mode',
	'aspiration'
] as const;
export type PrincipleKind = (typeof PRINCIPLE_KINDS)[number];

export const PRINCIPLE_STATUSES = ['active', 'provisional', 'retired'] as const;
export type PrincipleStatus = (typeof PRINCIPLE_STATUSES)[number];

/** Plural headings for the Constitution tab, in the order they're shown. */
export const KIND_HEADINGS: Record<PrincipleKind, string> = {
	value: 'Values',
	principle: 'Principles',
	belief: 'Beliefs',
	role: 'Roles',
	'failure-mode': 'Failure modes',
	aspiration: 'Aspirations'
};

/** Display order: what you hold, then who you are to people, then the honest part. */
export const KIND_ORDER: PrincipleKind[] = [
	'value',
	'principle',
	'belief',
	'role',
	'failure-mode',
	'aspiration'
];

/**
 * One sentence on what each kind is for, shown above its section. These matter
 * more than they look: the difference between a value and a principle is not
 * obvious, and a form that doesn't say gets filled with six of the same thing.
 */
export const KIND_BLURBS: Record<PrincipleKind, string> = {
	value: 'What you care about, named. The short word and what you actually mean by it.',
	principle: 'A rule you hold yourself to. Actionable — you can tell whether you kept it.',
	belief: 'A claim about how things are. Worth stating what would change your mind.',
	role: 'Who you are to someone else, and what that obliges. Alignment is role-relative.',
	'failure-mode': 'How you go wrong, in your own words. The most useful thing here.',
	aspiration: 'Who you are trying to become. Judged gently — this is the growing edge.'
};

/**
 * The two exemplar fields ask a different question per kind, which is what lets
 * one pair of columns serve six quite different things.
 */
export const EXEMPLAR_LABELS: Record<PrincipleKind, { exemplar: string; counter: string }> = {
	value: { exemplar: 'In practice this looks like…', counter: "I've broken this when…" },
	principle: { exemplar: 'In practice this looks like…', counter: "I've broken this when…" },
	belief: { exemplar: 'What follows from this…', counter: 'What would make me doubt it…' },
	role: { exemplar: 'What I owe here…', counter: 'How I let this role down…' },
	'failure-mode': { exemplar: 'It shows up when…', counter: 'Early warning signs…' },
	aspiration: { exemplar: 'Progress looks like…', counter: 'Still true of me…' }
};

/** Hints under the two exemplar boxes — concrete beats abstract, every time. */
export const EXEMPLAR_HINTS: Record<PrincipleKind, { exemplar: string; counter: string }> = {
	value: {
		exemplar: 'Name a real occasion. This is what makes it detectable in an entry.',
		counter: 'Without this the agent invents its own idea of breaking it.'
	},
	principle: {
		exemplar: 'A specific instance beats a restatement of the rule.',
		counter: 'The times you did not keep it, described plainly.'
	},
	belief: {
		exemplar: 'If this is true, what else follows?',
		counter: 'The observation that would count against it. This is the honest half.'
	},
	role: {
		exemplar: 'The duties, in the words you would use to the person themselves.',
		counter: 'How the failure usually looks from their side.'
	},
	'failure-mode': {
		exemplar: 'The trigger. What is happening when this starts?',
		counter: 'The first signs, before it is obvious. What you would want flagged.'
	},
	aspiration: {
		exemplar: 'What a step towards it would actually look like this week.',
		counter: 'What is still true of you today, said without flinching.'
	}
};

export type AssessmentBand = 'aligned' | 'mixed' | 'diverging' | 'insufficient';

/** How the Standing view words each band. Never a number, never a grade. */
export const BAND_LABELS: Record<AssessmentBand, string> = {
	aligned: 'Living it',
	mixed: 'Pulled both ways',
	diverging: 'Drifting',
	insufficient: 'Not enough to say'
};

export interface Principle {
	id: string;
	kind: PrincipleKind;
	title: string;
	statement: string;
	body: string;
	exemplar: string;
	counterExemplar: string;
	weight: number;
	conviction: number;
	origin: string;
	status: PrincipleStatus;
	reviewAfter: number | null;
	position: number;
	createdAt: number;
	updatedAt: number;
}

export interface PrincipleTension {
	id: string;
	aId: string;
	bId: string;
	note: string;
	createdAt: number;
}

export interface PrincipleRevision {
	id: string;
	principleId: string;
	snapshot: Partial<Principle>;
	changedFields: string[] | null;
	note: string;
	createdAt: number;
}

/**
 * A principle's track record, shown in the editor *before* you change anything.
 *
 * The point of the feature is that revising your stated character is easy and
 * honest. Seeing that a principle has been cited fourteen times and is falling
 * is what turns "soften the wording" into a real question.
 */
export interface PrincipleStats {
	cited: number;
	ofAssessments: number;
	lastCitedAt: number | null;
	meanScore: number | null;
	direction: 'rising' | 'steady' | 'falling' | 'unknown';
	/** Times this principle lost a trade-off, and to which principle. */
	lostTo: { principleId: string; times: number }[];
	wonOver: { principleId: string; times: number }[];
}
