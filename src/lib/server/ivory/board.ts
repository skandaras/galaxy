import type { ShelfClient } from './github';
import { setFrontmatterFields } from './frontmatter';
import { blobUrl, repoInfo, writeShelfFile, type ShelfProject } from './shelf';

/**
 * The Shelf's board: the repository's Issues, organised by label.
 *
 * `project:<slug>` marks both the project's parent issue and every task under
 * it, `discipline:<name>` sits on the project issue, and `agent:<task>` names
 * the Galaxy agent a task is for. Galaxy reads and creates issues, comments on
 * them, and keeps the status section of a project issue up to date (status.ts).
 * It never closes one, and it keeps no copy of their state beyond the client's
 * one-minute cache.
 */

export interface ShelfIssue {
	/** GitHub's database id, which the sub-issues API wants instead of the number. */
	id: number;
	number: number;
	title: string;
	body: string;
	url: string;
	state: 'open' | 'closed';
	labels: string[];
}

interface RawIssue {
	id: number;
	number: number;
	title: string;
	body: string | null;
	html_url: string;
	state: 'open' | 'closed';
	labels: (string | { name?: string })[];
	pull_request?: unknown;
}

/**
 * The agents a task may be labelled for. `ivory-synthesise` and
 * `ivory-redteam` do not run yet; their labels exist so the planner can file
 * work for them and a person can pick it up.
 */
export const IVORY_AGENTS = ['ivory-read', 'ivory-plan', 'ivory-synthesise', 'ivory-redteam'] as const;
export type IvoryAgent = (typeof IVORY_AGENTS)[number];

export const projectLabel = (slug: string) => `project:${slug}`;
export const disciplineLabel = (d: string) => `discipline:${d}`;
export const agentLabel = (a: string) => `agent:${a}`;

function toIssue(r: RawIssue): ShelfIssue {
	return {
		id: r.id,
		number: r.number,
		title: r.title,
		body: r.body ?? '',
		url: r.html_url,
		state: r.state,
		labels: r.labels.map((l) => (typeof l === 'string' ? l : (l.name ?? ''))).filter(Boolean)
	};
}

/**
 * Issues Galaxy filed in the last couple of minutes, per repository.
 *
 * Approving a plan used to make its tasks vanish. The page reloads the moment
 * the issues are created, and GitHub's issue list can answer that first read
 * without them; the client then cached the short list for a minute. So the
 * proposal disappeared, the tasks it became were nowhere on the page, and the
 * owner had no way to find them. What Galaxy has just created it now shows
 * whether or not GitHub's list has caught up. The cost: one closed on GitHub
 * inside those two minutes still shows until they pass.
 */
export const RECENT_ISSUE_MS = 2 * 60_000;
// Keyed by client, which is one per repository and token (see shelfClient), so
// changing the Shelf in Admin starts from nothing.
const recent = new WeakMap<ShelfClient, { at: number; issue: ShelfIssue }[]>();

function rememberCreated(client: ShelfClient, issue: ShelfIssue): void {
	const now = client.now();
	const list = (recent.get(client) ?? []).filter((r) => now - r.at < RECENT_ISSUE_MS);
	list.push({ at: now, issue });
	recent.set(client, list);
}

/** Every open issue, pull requests excluded (the issues endpoint returns both). */
export async function listOpenIssues(client: ShelfClient, opts: { fresh?: boolean } = {}): Promise<ShelfIssue[]> {
	const rows = await client.paged<RawIssue>('/issues?state=open', opts);
	const listed = rows.filter((r) => !r.pull_request).map(toIssue);
	const now = client.now();
	const seen = new Set(listed.map((i) => i.number));
	const missing = (recent.get(client) ?? [])
		.filter((r) => now - r.at < RECENT_ISSUE_MS && !seen.has(r.issue.number))
		.map((r) => r.issue);
	return [...listed, ...missing];
}

export async function getIssue(client: ShelfClient, number: number): Promise<ShelfIssue | null> {
	try {
		const r = await client.get<RawIssue>(`/issues/${number}`, { fresh: true });
		return r.pull_request ? null : toIssue(r);
	} catch {
		return null;
	}
}

/** The issue number a brief's `board:` URL points at, if it points into this repository. */
export function boardIssueNumber(board: string, repo: string): number | null {
	const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)\/?$/.exec(board.trim());
	if (!m || m[1].toLowerCase() !== repo.toLowerCase()) return null;
	return Number(m[2]);
}

/**
 * Which of a project's issues is the project itself.
 *
 * The brief's `board:` link is authoritative. Without one, the project issue is
 * the one carrying a `discipline:` label, since the conventions put those on
 * the project issue and nowhere else.
 */
export function projectIssueNumber(project: ShelfProject, issues: ShelfIssue[], repo: string): number | null {
	const linked = boardIssueNumber(project.board, repo);
	if (linked !== null) return linked;
	const mine = issues.filter((i) => i.labels.includes(projectLabel(project.slug)));
	return mine.find((i) => i.labels.some((l) => l.startsWith('discipline:')))?.number ?? null;
}

/** A project's open tasks: its labelled issues, less the project issue itself. */
export function projectTasks(project: ShelfProject, issues: ShelfIssue[], repo: string): ShelfIssue[] {
	const parent = projectIssueNumber(project, issues, repo);
	return issues.filter((i) => i.labels.includes(projectLabel(project.slug)) && i.number !== parent);
}

interface LabelSpec {
	name: string;
	color: string;
	description: string;
}

export function labelSet(projects: ShelfProject[]): LabelSpec[] {
	const out: LabelSpec[] = IVORY_AGENTS.map((a) => ({
		name: agentLabel(a),
		color: '5319e7',
		description: `Task for the ${a} agent in Galaxy`
	}));
	for (const p of projects) {
		out.push({ name: projectLabel(p.slug), color: '0e8a16', description: `Ivory Tower project ${p.slug}` });
		for (const d of p.disciplines) {
			out.push({ name: disciplineLabel(d), color: '1d76db', description: `Discipline: ${d}` });
		}
	}
	return [...new Map(out.map((l) => [l.name.toLowerCase(), l])).values()];
}

/**
 * Create whichever labels are missing. Safe to run any number of times: an
 * existing label is left exactly as it is, colour and description included.
 */
export async function ensureLabels(client: ShelfClient, wanted: LabelSpec[]): Promise<string[]> {
	const have = new Set(
		(await client.paged<{ name: string }>('/labels', { fresh: true })).map((l) => l.name.toLowerCase())
	);
	const created: string[] = [];
	for (const l of wanted) {
		if (have.has(l.name.toLowerCase())) continue;
		await client.send('POST', '/labels', l);
		created.push(l.name);
	}
	return created;
}

/** An issue GitHub created but would not label, which leaves it invisible to the Shelf. */
export class IssueLabelError extends Error {
	constructor(
		readonly issue: ShelfIssue,
		readonly missing: string[]
	) {
		super(
			`GitHub created #${issue.number} but would not give it ${missing.join(', ')}, so Galaxy cannot see it. ` +
				'The GitHub token needs Contents and Issues read/write on the Shelf repository; label the issue by hand on GitHub once that is fixed.'
		);
		this.name = 'IssueLabelError';
	}
}

/**
 * Create an issue and make sure it carries its labels.
 *
 * GitHub silently drops the labels on a new issue when the caller lacks push
 * access, and still answers 201. That is how an approved plan once became a
 * set of unlabelled issues: on GitHub, but invisible to every Shelf view, which
 * finds tasks by their `project:` label alone. The answer is read back, and a
 * missing label is added with the labels endpoint; if GitHub refuses that too,
 * this throws rather than report a task nobody can find.
 */
export async function createIssue(
	client: ShelfClient,
	issue: { title: string; body: string; labels: string[] }
): Promise<ShelfIssue> {
	const created = toIssue(await client.send<RawIssue>('POST', '/issues', issue));
	const lacking = (have: string[]) => {
		const lower = new Set(have.map((l) => l.toLowerCase()));
		return issue.labels.filter((l) => !lower.has(l.toLowerCase()));
	};
	let missing = lacking(created.labels);
	if (missing.length) {
		try {
			const now = await client.send<(string | { name?: string })[]>('POST', `/issues/${created.number}/labels`, {
				labels: missing
			});
			created.labels = now.map((l) => (typeof l === 'string' ? l : (l.name ?? ''))).filter(Boolean);
			missing = lacking(created.labels);
		} catch {
			// Refused outright: reported below exactly as a silent drop would be.
		}
	}
	rememberCreated(client, created);
	if (missing.length) throw new IssueLabelError(created, missing);
	return created;
}

export async function commentOnIssue(client: ShelfClient, number: number, body: string): Promise<string> {
	const r = await client.send<{ html_url: string }>('POST', `/issues/${number}/comments`, { body });
	return r.html_url;
}

/**
 * Hang a task under its project issue. GitHub's sub-issues API takes the
 * child's id, not its number.
 */
export async function addSubIssue(client: ShelfClient, parentNumber: number, childId: number): Promise<void> {
	await client.send('POST', `/issues/${parentNumber}/sub_issues`, { sub_issue_id: childId });
}

/**
 * Replace an issue's body. Galaxy edits only project issues, and only the
 * status section of them; see status.ts.
 */
export async function updateIssueBody(client: ShelfClient, number: number, body: string): Promise<ShelfIssue> {
	const updated = toIssue(await client.send<RawIssue>('PATCH', `/issues/${number}`, { body }));
	// A project issue created moments ago may be showing from the overlay while
	// GitHub's list catches up; its copy there must carry the new body too.
	for (const r of recent.get(client) ?? []) if (r.issue.number === number) r.issue = updated;
	return updated;
}

/**
 * The project's own issue, created if it has none.
 *
 * Nothing used to create one: the conventions called for it, but a project
 * written by hand on GitHub had only its brief, so approved tasks had no
 * parent to nest under and there was nowhere on the board for a project's
 * status. The new issue carries the project and discipline labels, and its URL
 * is written into the brief's `board:` field so it is found by link from then
 * on.
 */
export async function ensureProjectIssue(client: ShelfClient, project: ShelfProject): Promise<number> {
	const found = projectIssueNumber(project, await listOpenIssues(client, { fresh: true }), client.repo);
	if (found !== null) return found;

	const labels = [projectLabel(project.slug), ...project.disciplines.map(disciplineLabel)];
	await ensureLabels(
		client,
		labelSet([project]).filter((l) => labels.includes(l.name))
	);
	const briefPath = `projects/${project.slug}/brief.md`;
	const info = await repoInfo(client);
	let issue: ShelfIssue;
	let unlabelled: IssueLabelError | null = null;
	try {
		issue = await createIssue(client, {
			title: project.title,
			body: [project.question, '', `Brief: ${blobUrl(info, briefPath)}`].join('\n').trim(),
			labels
		});
	} catch (err) {
		if (!(err instanceof IssueLabelError)) throw err;
		// It exists without its labels. Linked from the brief all the same, so
		// the next attempt finds this one instead of filing another.
		issue = err.issue;
		unlabelled = err;
	}
	const brief = await client.file(briefPath, { fresh: true });
	if (brief !== null) {
		await writeShelfFile(
			client,
			briefPath,
			setFrontmatterFields(brief, { board: issue.url }),
			`Link ${project.slug} to its project issue #${issue.number}`
		);
	}
	if (unlabelled) throw unlabelled;
	return issue.number;
}
