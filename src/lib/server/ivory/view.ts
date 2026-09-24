import { GithubError, type ShelfClient } from './github';
import { listOpenIssues, projectIssueNumber, projectLabel, projectTasks, type ShelfIssue } from './board';
import { getProject, groupByDiscipline, listProjects, repoInfo, type ShelfProject } from './shelf';
import { readStatus, type ProjectStatus } from './status';

/** What the Shelf pages are served. Assembled here so the routes stay thin. */

export interface IndexProject extends ShelfProject {
	openTasks: number;
	status: ProjectStatus | null;
}

/** The status line from the project's issue, read from the issue list already fetched. */
function statusOf(project: ShelfProject, issues: ShelfIssue[], repo: string): ProjectStatus | null {
	const n = projectIssueNumber(project, issues, repo);
	return readStatus(issues.find((i) => i.number === n)?.body);
}

export interface ShelfIndex {
	repo: string;
	repoUrl: string;
	groups: { discipline: string; projects: IndexProject[] }[];
	projectCount: number;
}

export async function shelfIndex(client: ShelfClient): Promise<ShelfIndex> {
	const [info, projects, issues] = await Promise.all([
		repoInfo(client),
		listProjects(client),
		listOpenIssues(client)
	]);
	const withCounts = projects.map((p) => ({
		...p,
		openTasks: projectTasks(p, issues, client.repo).length,
		status: statusOf(p, issues, client.repo)
	}));
	return {
		repo: client.repo,
		repoUrl: info.html_url,
		groups: groupByDiscipline(withCounts) as ShelfIndex['groups'],
		projectCount: projects.length
	};
}

export interface IssueView {
	number: number;
	title: string;
	url: string;
	labels: string[];
	agent: string | null;
}

export function issueView(i: ShelfIssue): IssueView {
	const agent = i.labels.find((l) => l.startsWith('agent:'))?.slice('agent:'.length) ?? null;
	return { number: i.number, title: i.title, url: i.url, labels: i.labels, agent };
}

export async function shelfProjectView(client: ShelfClient, slug: string) {
	const detail = await getProject(client, slug);
	if (!detail) return null;
	const [issues, info] = await Promise.all([listOpenIssues(client), repoInfo(client)]);
	const parent = projectIssueNumber(detail.project, issues, client.repo);
	return {
		...detail,
		repo: client.repo,
		// Open and closed: the way back to a project's tasks when the view shows none.
		issuesUrl: `${info.html_url}/issues?q=${encodeURIComponent(`is:issue label:"${projectLabel(slug)}"`)}`,
		projectIssue: parent,
		projectIssueUrl: issues.find((i) => i.number === parent)?.url ?? null,
		status: statusOf(detail.project, issues, client.repo),
		issues: projectTasks(detail.project, issues, client.repo).map(issueView)
	};
}

/** A GitHub failure as something a person can act on, rather than a stack trace. */
export function shelfErrorMessage(err: unknown, repo: string): string {
	if (err instanceof GithubError) {
		if (err.status === 404) return `The Shelf repository ${repo} was not found, or the GitHub token cannot see it.`;
		if (err.status === 401) return 'GitHub refused the stored token. Replace it in Admin → Settings → GitHub.';
		if (err.status === 403) return `GitHub refused the request (rate limit or token scope): ${err.message}`;
		return err.message;
	}
	return err instanceof Error ? err.message : String(err);
}
