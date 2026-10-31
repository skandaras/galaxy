import type { ShelfClient } from './github';
import { disciplineLabel, ensureLabels, labelSet, projectLabel } from './board';
import { normaliseDiscipline, projectFromBrief, SLUG, writeShelfFile } from './shelf';
import { writeProjectStatus } from './status';

/**
 * A new project from Galaxy's form, written to the Shelf the way the brief
 * template lays it out, so nobody has to hand-write frontmatter on GitHub.
 */

export const VALIDATION_TIERS = ['reading', 'computation', 'lab'] as const;
export const MAX_DISCIPLINES = 6;

export interface ProjectInput {
	title: string;
	slug: string;
	disciplines: string[];
	validationTier: (typeof VALIDATION_TIERS)[number];
	question: string;
	whyNew: string;
	scopeIn: string;
	scopeOut: string;
	doneWhen: string;
	killCriteria: string;
	startingPoints: string;
	plannerNotes: string;
}

export class ProjectError extends Error {
	constructor(
		message: string,
		readonly status = 400,
		readonly problems: Record<string, string> = {}
	) {
		super(message);
		this.name = 'ProjectError';
	}
}

/** A folder name from a title: lower-case, dashes, at most 64 characters, cut at a dash. */
export function slugify(title: string): string {
	const s = title
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	if (s.length <= 64) return s;
	const cut = s.slice(0, 64);
	return cut.slice(0, cut.lastIndexOf('-') > 20 ? cut.lastIndexOf('-') : 64).replace(/-+$/, '');
}

/**
 * The form's fields, checked. Every problem is returned at once and keyed by
 * field, so the page can put each message beside the field it is about.
 */
export function validateProjectInput(raw: Record<string, unknown>): { input: ProjectInput; problems: Record<string, string> } {
	const str = (k: string) => (typeof raw[k] === 'string' ? (raw[k] as string).trim() : '');
	const problems: Record<string, string> = {};
	const title = str('title');
	const slug = str('slug') || slugify(title);
	const disciplines = [
		...new Set(
			(Array.isArray(raw.disciplines) ? raw.disciplines : String(raw.disciplines ?? '').split(','))
				.map((d) => normaliseDiscipline(String(d)))
				.filter(Boolean)
		)
	];
	const tier = str('validationTier') || 'reading';
	const input: ProjectInput = {
		title,
		slug,
		disciplines,
		validationTier: tier as ProjectInput['validationTier'],
		question: str('question'),
		whyNew: str('whyNew'),
		scopeIn: str('scopeIn'),
		scopeOut: str('scopeOut'),
		doneWhen: str('doneWhen'),
		killCriteria: str('killCriteria'),
		startingPoints: str('startingPoints'),
		plannerNotes: str('plannerNotes')
	};

	if (!title || title.length > 120) problems.title = 'A title of 1 to 120 characters is needed.';
	if (!SLUG.test(slug)) problems.slug = 'Lower-case letters, digits and dashes, starting with a letter or digit, at most 64.';
	// /ivory/new is this form, so a project of that name could never be opened.
	else if (slug === 'new') problems.slug = '"new" is taken by the new-project page; choose another.';
	if (!disciplines.length) problems.disciplines = 'At least one discipline is needed.';
	else if (disciplines.length > MAX_DISCIPLINES) problems.disciplines = `At most ${MAX_DISCIPLINES} disciplines.`;
	if (!(VALIDATION_TIERS as readonly string[]).includes(tier)) problems.validationTier = 'reading, computation or lab.';
	if (!input.question) problems.question = 'The question is the one thing the planner cannot work without.';
	else if (input.question.length > 600) problems.question = 'Keep the question to a sentence or two.';
	if (!input.doneWhen) problems.doneWhen = 'Say what ends the project.';
	if (!input.killCriteria) problems.killCriteria = 'Say what would stop it early; the planner checks these first.';
	for (const k of ['whyNew', 'scopeIn', 'scopeOut', 'doneWhen', 'killCriteria', 'startingPoints', 'plannerNotes'] as const) {
		if (input[k].length > 4000) problems[k] = 'At most 4000 characters.';
	}
	return { input, problems };
}

/**
 * A heading typed into a field would end its section early, so a line that
 * starts with `#` is escaped and reads as text.
 */
function section(text: string): string {
	return text
		.split('\n')
		.map((l) => l.replace(/^(\s*)(#{1,6}\s)/, '$1\\$2'))
		.join('\n')
		.trim();
}

/** The brief template, filled in. Sections left blank keep their headings. */
export function renderBrief(input: ProjectInput, created: Date): string {
	return [
		'---',
		`slug: ${input.slug}`,
		`title: ${JSON.stringify(input.title)}`,
		`disciplines: [${input.disciplines.join(', ')}]`,
		'board: ""',
		`validation_tier: ${input.validationTier}`,
		`created: ${created.toISOString().slice(0, 10)}`,
		'---',
		'<!-- No status field. Status lives on the board only. -->',
		'',
		`# ${input.title}`,
		'',
		'## Question',
		// One paragraph: it is what the index shows and what the planner is given.
		section(input.question.replace(/\s*\n\s*/g, ' ')),
		'',
		'## Why this might be new',
		section(input.whyNew),
		'',
		'## Scope',
		`In: ${section(input.scopeIn)}`,
		`Out: ${section(input.scopeOut)}`,
		'',
		'## Done when',
		section(input.doneWhen),
		'',
		'## Kill criteria',
		section(input.killCriteria),
		'',
		'## Starting points',
		section(input.startingPoints),
		'',
		'## Notes for the planner',
		section(input.plannerNotes),
		''
	].join('\n');
}

/**
 * Write the brief, give the project its issue, and set its first status.
 *
 * The brief is written first, so a project exists as soon as anything does;
 * the issue comes second (with its URL written back into `board:`), and a
 * failure there is reported as a warning rather than undoing the project. The
 * next status write creates the issue if this one could not.
 */
export async function createProject(
	client: ShelfClient,
	raw: Record<string, unknown>,
	now = new Date()
): Promise<{ slug: string; warning?: string }> {
	const { input, problems } = validateProjectInput(raw);
	if (Object.keys(problems).length) throw new ProjectError('Some fields need attention.', 400, problems);

	const briefPath = `projects/${input.slug}/brief.md`;
	if ((await client.file(briefPath, { fresh: true })) !== null) {
		throw new ProjectError(`A project called ${input.slug} is already on the Shelf.`, 409, {
			slug: 'Already taken; choose another.'
		});
	}
	const brief = renderBrief(input, now);
	const project = projectFromBrief(input.slug, brief);
	const labels = [projectLabel(input.slug), ...input.disciplines.map(disciplineLabel)];
	await ensureLabels(
		client,
		labelSet([project]).filter((l) => labels.includes(l.name))
	);
	await writeShelfFile(client, briefPath, brief, `Create project ${input.slug} from Galaxy`);

	const warning = await writeProjectStatus(
		client,
		input.slug,
		{ text: 'Project created. Next: plan its first tasks.', by: 'Galaxy' },
		now
	).then(
		() => undefined,
		(err) => `The project was created, but its GitHub issue was not: ${err instanceof Error ? err.message : String(err)}`
	);
	return warning ? { slug: input.slug, warning } : { slug: input.slug };
}
