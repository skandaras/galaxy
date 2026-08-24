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
	value: 'What you care about, named. The word, and what you actually mean by it.',
	principle: 'A rule you hold yourself to. You can tell whether you kept it.',
	belief: 'Something you hold to be true. Worth saying what would change your mind.',
	role: 'Who you are to someone, and what you owe them.',
	'failure-mode': 'How you go wrong. Saying it plainly is what makes it useful.',
	aspiration: 'Who you are trying to become. Judged by movement, not by whether you are there yet.'
};

/**
 * The two exemplar fields ask a different question per kind, which is what lets
 * one pair of columns serve six quite different things.
 *
 * The prompt reads these too (see constitutionForPrompt), so the model is told
 * the same question the person was asked. It used to describe all six as
 * "keeping it" and "breaking it", which was right for values, principles and
 * roles and wrong for the rest — a failure mode's first field is how you go
 * wrong, and calling that "keeping it" inverts the whole entry.
 */
export const EXEMPLAR_LABELS: Record<PrincipleKind, { exemplar: string; counter: string }> = {
	value: { exemplar: 'In practice this looks like…', counter: "I've broken this when…" },
	principle: { exemplar: 'In practice this looks like…', counter: "I've broken this when…" },
	belief: { exemplar: 'What follows from this…', counter: 'What would change my mind…' },
	role: { exemplar: 'What I owe here…', counter: 'How I let this role down…' },
	'failure-mode': { exemplar: 'It usually starts when…', counter: 'The early signs…' },
	aspiration: { exemplar: 'A step towards it looks like…', counter: 'What usually gets in the way…' }
};

/** Hints under the two exemplar boxes — concrete beats abstract, every time. */
export const EXEMPLAR_HINTS: Record<PrincipleKind, { exemplar: string; counter: string }> = {
	value: {
		exemplar: 'A real occasion, not the value restated. This is what a reading looks for.',
		counter: 'The times you did not. Without it, a reading guesses at what breaking it means.'
	},
	principle: {
		exemplar: 'A specific time you kept it, rather than the rule again.',
		counter: 'The times you did not keep it, described plainly.'
	},
	belief: {
		exemplar: 'If this is true, what else follows?',
		counter: 'What you would have to see to think you were wrong.'
	},
	role: {
		exemplar: 'In the words you would use to them.',
		counter: "What it looks like from their side when you don't."
	},
	'failure-mode': {
		exemplar: 'What is usually happening when it starts.',
		counter: 'The first signs, before it is obvious.'
	},
	aspiration: {
		exemplar: 'Something small and real you could do this week.',
		counter: 'The thing that tends to stop you. Naming it lets a reading notice when it is happening.'
	}
};

/**
 * Example title and statement per kind, shown as placeholders.
 *
 * These were a single hard-coded pair — "Honesty" and a value statement — on all
 * six forms, so a failure mode suggested "Honesty" as a name and a value's
 * sentence as its shape. A placeholder is not a question and holds no data, but
 * a wrong example is worse than none: it is the first thing read and it sets
 * what the field appears to want.
 */
export const KIND_PLACEHOLDERS: Record<PrincipleKind, { title: string; statement: string }> = {
	value: {
		title: 'Honesty',
		statement: 'I say the uncomfortable thing kindly rather than the comfortable thing smoothly.'
	},
	principle: {
		title: 'No promises I cannot keep',
		statement: 'I would rather disappoint someone now than later.'
	},
	belief: {
		title: 'Meaning is made',
		statement: 'It is built by what I repeatedly do, not found somewhere and picked up.'
	},
	role: {
		title: 'Father',
		statement: 'The one job I do not get to redo.'
	},
	'failure-mode': {
		title: 'Conflict avoidance',
		statement: 'I go quiet rather than disagree in a room.'
	},
	aspiration: {
		title: 'Patience',
		statement: 'I want to be slower to answer and quicker to ask.'
	}
};

/**
 * How the agent should read each kind, sent alongside the entry.
 *
 * The labels alone cannot carry this. A failure mode's first field describes the
 * failure *occurring*, so without being told, a model reading it beside a value's
 * "in practice this looks like" treats both as evidence of living well.
 */
export const KIND_READING_NOTES: Record<PrincipleKind, string> = {
	value: 'Something they care about. Living it is alignment; acting against it is a gap.',
	principle:
		'A rule they hold themselves to. They can tell whether they kept it, and so can you.',
	belief:
		'A claim they hold. Judge whether they acted consistently with it, not whether it is correct — and treat the second field as what would change their mind, not as a failure.',
	role: 'An obligation to a particular person. Judge against what they said that role owes.',
	'failure-mode':
		'How they go wrong. The first field is the failure happening, not the principle being kept — seeing it in an entry is a gap, and the second field is the early warning they asked to have flagged.',
	aspiration:
		'Who they are trying to become. Judge by movement towards it, never by whether they have arrived, and treat the second field as the obstacle rather than as a failing.'
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
