import { emptyDraft, type Draft, type DraftEntry, type ParsePart } from './profile-draft';
import type { Kind } from './profile-taxonomy';

/**
 * The questions a new profile starts from, and what each answer becomes.
 *
 * A typed module rather than JSON, so the compiler checks every path and kind
 * and the file can say why a question is shaped the way it is. No server
 * imports: the page draws the questions and the server builds the draft from
 * the same copy.
 *
 * Short answers become entries through a template, which is exact and free.
 * Anything a person writes at length goes to one parse call, because no
 * template turns "two kids, a dog and a long commute" into three entries.
 */

interface Base {
	id: string;
	label: string;
	placeholder?: string;
}

/** One answer, one claim: "Goes by {value}." */
export interface TextQuestion extends Base {
	type: 'text';
	path: string;
	kind: Kind;
	pin: boolean;
	claim: string;
	/** Filled from the browser, so the person only has to confirm it. */
	prefill?: 'timezone';
}

/** A comma-separated answer as one claim: "Uses {list}." */
export interface ListQuestion extends Base {
	type: 'list';
	path: string;
	kind: Kind;
	pin: boolean;
	claim: string;
}

/** Written at length and sorted into entries by the parse call. */
export interface FreeQuestion extends Base {
	type: 'free';
	/** Where the answer mostly belongs, as a hint to the parse; it may file elsewhere. */
	about: string;
	/**
	 * Health and money are asked only after a box is ticked. Both are private by
	 * path, and a person who never meant to say anything about them should not
	 * find a question waiting.
	 */
	optIn?: string;
}

/** An organisation they name, kept as someone in their world and as a claim. */
export interface EntityQuestion extends Base {
	type: 'entity';
	relation: string;
	path: string;
	kind: Kind;
	pin: boolean;
	claim: string;
}

/** Rows: people and pets, projects, or what is on their plate right now. */
export interface RowsQuestion extends Base {
	type: 'people' | 'projects' | 'now';
	max: number;
}

export type Question = TextQuestion | ListQuestion | FreeQuestion | EntityQuestion | RowsQuestion;

export interface SurveyStep {
	id: string;
	title: string;
	intro: string;
	questions: Question[];
}

/** How long a "right now" row stays true unless the person says otherwise. */
export const NOW_DAYS = 30;

export const SURVEY: SurveyStep[] = [
	{
		id: 'basics',
		title: 'Basics',
		intro: 'Who you are, in the few lines every agent gets.',
		questions: [
			{
				id: 'name',
				type: 'text',
				label: 'What should agents call you?',
				placeholder: 'Tama',
				path: 'identity/basics',
				kind: 'fact',
				pin: true,
				claim: 'Goes by {value}.'
			},
			{
				id: 'place',
				type: 'text',
				label: 'Where do you live?',
				placeholder: 'Auckland, New Zealand',
				path: 'identity/basics',
				kind: 'fact',
				pin: true,
				claim: 'Lives in {value}.'
			},
			{
				id: 'timezone',
				type: 'text',
				label: 'Your time zone',
				prefill: 'timezone',
				path: 'identity/basics',
				kind: 'fact',
				pin: true,
				claim: 'Time zone: {value}.'
			},
			{
				id: 'languages',
				type: 'list',
				label: 'Languages you speak',
				placeholder: 'English, te reo Māori',
				path: 'identity/basics',
				kind: 'fact',
				pin: false,
				claim: 'Speaks {list}.'
			},
			{
				id: 'background',
				type: 'free',
				label: 'Anything about where you come from that shapes how you see things?',
				placeholder: 'Grew up in Rotorua; trained as an architect before moving into software.',
				about: 'identity'
			}
		]
	},
	{
		id: 'work',
		title: 'Work',
		intro: 'What you do and what you do it with. The coding agent sees your tools and expertise.',
		questions: [
			{
				id: 'role',
				type: 'text',
				label: 'What do you do?',
				placeholder: 'Staff engineer leading a platform team',
				path: 'work/role',
				kind: 'fact',
				pin: true,
				claim: 'Role: {value}.'
			},
			{
				id: 'organisation',
				type: 'entity',
				label: 'Where do you work?',
				placeholder: 'Acme',
				relation: 'employer',
				path: 'work/organisation',
				kind: 'fact',
				pin: false,
				claim: 'Works at {value}.'
			},
			{
				id: 'expertise',
				type: 'list',
				label: 'What are you strongest at?',
				placeholder: 'TypeScript, SQLite, distributed systems',
				path: 'work/expertise',
				kind: 'fact',
				// Pinned with tools: they are the two things the coding agent sees,
				// and an agent that has to look up what someone knows rarely does.
				pin: true,
				claim: 'Strongest in {list}.'
			},
			{
				id: 'tools',
				type: 'list',
				label: 'What do you work with every day?',
				placeholder: 'Neovim, pnpm, Docker on Linux',
				path: 'work/tools',
				kind: 'fact',
				pin: true,
				claim: 'Uses {list}.'
			},
			{
				id: 'projects',
				type: 'projects',
				label: 'What are you working on?',
				max: 5
			},
			{
				id: 'work-more',
				type: 'free',
				label: 'Anything else about your work an agent should know?',
				about: 'work'
			}
		]
	},
	{
		id: 'people',
		title: 'People',
		intro:
			'Anyone you might mention to an agent: a partner, children, close friends, pets. Only a chat agent sees them.',
		questions: [{ id: 'people', type: 'people', label: 'Who is in your life?', max: 12 }]
	},
	{
		id: 'life',
		title: 'Life',
		intro: 'How your days run. Health and money are private and only asked if you tick them.',
		questions: [
			{
				id: 'home',
				type: 'free',
				label: 'Where do you live, and who with?',
				placeholder: 'A villa in Grey Lynn with Aroha and Nikau.',
				about: 'life/home'
			},
			{
				id: 'week',
				type: 'free',
				label: 'What does a usual week look like?',
				placeholder: 'School run on Tuesdays and Thursdays; football coaching on Saturday mornings.',
				about: 'life/routines'
			},
			{
				id: 'transport',
				type: 'text',
				label: 'How do you get around?',
				placeholder: 'bike and train; no car',
				path: 'life/logistics',
				kind: 'fact',
				pin: false,
				claim: 'Gets around by {value}.'
			},
			{
				id: 'constraints',
				type: 'list',
				label: 'Anything an answer has to respect?',
				placeholder: 'vegetarian, no stairs, nothing after 9pm',
				path: 'life/constraints',
				kind: 'constraint',
				pin: true,
				claim: 'Has to work around: {list}.'
			},
			{
				id: 'health',
				type: 'free',
				label: 'Anything about your health an answer should allow for?',
				placeholder: 'Coeliac; avoids gluten entirely.',
				about: 'life/health',
				optIn: 'Add something about my health'
			},
			{
				id: 'money',
				type: 'free',
				label: 'Anything about money an answer should allow for?',
				placeholder: 'Saving for a house deposit by 2028.',
				about: 'life/money',
				optIn: 'Add something about money'
			}
		]
	},
	{
		id: 'interests',
		title: 'Interests',
		intro: 'What you are drawn to when nothing is asking for your time.',
		questions: [
			{
				id: 'pursuits',
				type: 'list',
				label: 'What do you do for fun?',
				placeholder: 'trail running, sailing, woodwork',
				path: 'interests/pursuits',
				kind: 'fact',
				pin: false,
				claim: 'Spends free time on {list}.'
			},
			{
				id: 'learning',
				type: 'list',
				label: 'What are you learning?',
				placeholder: 'te reo Māori, sailing',
				path: 'interests/learning',
				kind: 'goal',
				pin: false,
				claim: 'Learning {list}.'
			},
			{
				id: 'taste',
				type: 'free',
				label: 'What do you like in books, music, food or design?',
				placeholder: 'Scandinavian crime fiction; spare, quiet design.',
				about: 'interests/taste'
			}
		]
	},
	{
		id: 'now',
		title: 'Right now',
		intro: `What is on your plate for the next few weeks. Each line is pinned, and drops out on its date (${NOW_DAYS} days unless you change it).`,
		questions: [{ id: 'now', type: 'now', label: 'What is on your plate?', max: 5 }]
	}
];

export interface PersonRow {
	name: string;
	kind: 'person' | 'pet';
	relation: string;
	line: string;
}

export interface ProjectRow {
	name: string;
	line: string;
}

export interface NowRow {
	what: string;
	/** `YYYY-MM-DD`. */
	until: string;
}

export interface SurveyAnswers {
	/** Text, list, free and entity answers, by question id. */
	text: Record<string, string>;
	/** Opt-in questions the person ticked. Anything else behind a box is ignored. */
	optedIn: string[];
	people: PersonRow[];
	projects: ProjectRow[];
	now: NowRow[];
}

export const emptyAnswers = (): SurveyAnswers => ({
	text: {},
	optedIn: [],
	people: [],
	projects: [],
	now: []
});

/** Trimmed and without trailing punctuation, so the template's full stop is the only one. */
const bare = (raw: string) => raw.replace(/\s+/g, ' ').trim().replace(/[.;,]+$/, '');

/** A line as a sentence: ends on a full stop unless it already ends on punctuation. */
const sentence = (raw: string) => {
	const s = raw.replace(/\s+/g, ' ').trim();
	return /[.!?)]$/.test(s) ? s : `${s}.`;
};

/** "a, b, c" as "a, b and c". */
export function joinList(raw: string): string {
	const items = raw
		.split(/[,\n]/)
		.map(bare)
		.filter(Boolean);
	if (items.length < 2) return items[0] ?? '';
	return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

const entry = (over: Partial<DraftEntry> & Pick<DraftEntry, 'path' | 'claim'>): DraftEntry => ({
	kind: 'fact',
	pinned: false,
	until: null,
	about: null,
	sensitivity: null,
	...over
});

/**
 * The draft the structured answers make, and the free ones the parse call
 * still has to read. A blank answer makes nothing, and so does an opt-in
 * question whose box is not ticked, whatever text it holds.
 */
export function surveyDraft(answers: SurveyAnswers): { draft: Draft; parts: ParsePart[] } {
	const draft = emptyDraft();
	const parts: ParsePart[] = [];
	const said = (id: string) => (answers.text[id] ?? '').trim();

	for (const q of SURVEY.flatMap((s) => s.questions)) {
		if (q.type === 'text' || q.type === 'list' || q.type === 'entity') {
			const raw = said(q.id);
			const value = q.type === 'list' ? joinList(raw) : bare(raw);
			if (!value) continue;
			const claim = q.claim.replace(q.type === 'list' ? '{list}' : '{value}', value);
			if (q.type === 'entity') {
				draft.people.push({ name: value, kind: 'organisation', relation: q.relation, aka: [] });
			}
			draft.entries.push(
				entry({
					path: q.path,
					kind: q.kind,
					claim,
					pinned: q.pin,
					about: q.type === 'entity' ? value : null
				})
			);
		} else if (q.type === 'free') {
			const text = said(q.id);
			if (!text || (q.optIn && !answers.optedIn.includes(q.id))) continue;
			parts.push({ label: q.label, about: q.about, text });
		}
	}

	for (const p of answers.people.slice(0, rowsMax('people'))) {
		const name = bare(p.name);
		if (!name) continue;
		draft.people.push({
			name,
			kind: p.kind === 'pet' ? 'pet' : 'person',
			relation: bare(p.relation),
			aka: []
		});
		if (p.line.trim()) draft.entries.push(entry({ path: `people/${name}`, claim: sentence(p.line) }));
	}

	for (const p of answers.projects.slice(0, rowsMax('projects'))) {
		const name = bare(p.name);
		if (!name) continue;
		draft.people.push({ name, kind: 'project', relation: '', aka: [] });
		draft.entries.push(
			entry({
				path: 'work/projects',
				kind: 'goal',
				// The name in the line itself: the brief shows claims, not who they
				// are about, so "A self-hosted AI workspace." alone would name nothing.
				claim: p.line.trim() ? `${name}: ${sentence(p.line)}` : `Working on ${name}.`,
				about: name
			})
		);
	}

	for (const row of answers.now.slice(0, rowsMax('now'))) {
		if (!row.what.trim()) continue;
		draft.entries.push(
			entry({
				path: 'life/commitments',
				kind: 'goal',
				claim: sentence(row.what),
				pinned: true,
				until: /^\d{4}-\d{2}-\d{2}$/.test(row.until) ? row.until : null
			})
		);
	}

	return { draft, parts };
}

function rowsMax(type: RowsQuestion['type']): number {
	const q = SURVEY.flatMap((s) => s.questions).find((x): x is RowsQuestion => x.type === type);
	return q?.max ?? 0;
}

/** The default end date for a "right now" row, from a given day. */
export function nowUntil(today: Date): string {
	return new Date(today.getTime() + NOW_DAYS * 86_400_000).toISOString().slice(0, 10);
}

/** Answers as they arrived over the wire, made the shape they claim to be. */
export function readAnswers(raw: unknown): SurveyAnswers {
	const a = (raw ?? {}) as Record<string, unknown>;
	const text = (v: unknown) => (typeof v === 'string' ? v.slice(0, 4_000) : '');
	const rows = (v: unknown): Record<string, unknown>[] =>
		Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : [];
	const answers = emptyAnswers();
	const given = (a.text ?? {}) as Record<string, unknown>;
	for (const q of SURVEY.flatMap((s) => s.questions)) {
		const v = text(given[q.id]);
		if (v) answers.text[q.id] = v;
	}
	answers.optedIn = Array.isArray(a.optedIn) ? a.optedIn.filter((x): x is string => typeof x === 'string') : [];
	answers.people = rows(a.people).map((p) => ({
		name: text(p.name),
		kind: p.kind === 'pet' ? 'pet' : 'person',
		relation: text(p.relation),
		line: text(p.line)
	}));
	answers.projects = rows(a.projects).map((p) => ({ name: text(p.name), line: text(p.line) }));
	answers.now = rows(a.now).map((r) => ({ what: text(r.what), until: text(r.until) }));
	return answers;
}

/** The step that asks about a domain, for the links on the Profile page. */
export function stepFor(domain: string): string | null {
	if (domain === 'identity') return 'basics';
	return SURVEY.some((s) => s.id === domain) ? domain : null;
}
