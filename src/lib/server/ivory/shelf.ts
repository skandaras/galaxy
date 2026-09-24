import { GithubError, encodePath, type ShelfClient } from './github';
import { fmList, fmString, parseFrontmatter, type FmValue } from './frontmatter';

/**
 * The Shelf as Galaxy sees it: project folders in a GitHub repository.
 *
 * Nothing here is stored. Projects, notes and claims are read from the
 * repository on demand (through the client's one-minute cache), and project
 * and task status is never held at all: a brief has no status field, and the
 * board is the repository's Issues. Galaxy's own Boards are a different thing
 * and this module never touches them.
 */

export const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface ShelfProject {
	slug: string;
	title: string;
	disciplines: string[];
	/** First paragraph under "## Question", comments removed. */
	question: string;
	/** URL of the project's parent issue, from the brief. */
	board: string;
	validationTier: string;
	created: string;
}

export interface ShelfEntry {
	path: string;
	name: string;
	url: string;
}

export interface ShelfClaim extends ShelfEntry {
	id: string;
	title: string;
	status: string;
}

export interface ShelfProjectDetail {
	project: ShelfProject;
	/** The brief below its frontmatter, for rendering. */
	briefBody: string;
	briefUrl: string;
	notes: ShelfEntry[];
	claims: ShelfClaim[];
}

interface RepoInfo {
	default_branch: string;
	html_url: string;
}

interface TreeEntry {
	path: string;
	type: 'blob' | 'tree' | 'commit';
}

export async function repoInfo(client: ShelfClient): Promise<RepoInfo> {
	return client.get<RepoInfo>('');
}

/** Every file path on the default branch. An empty repository has none. */
export async function listPaths(client: ShelfClient, opts: { fresh?: boolean } = {}): Promise<string[]> {
	const info = await repoInfo(client);
	try {
		const tree = await client.get<{ tree: TreeEntry[]; truncated?: boolean }>(
			`/git/trees/${encodeURIComponent(info.default_branch)}?recursive=1`,
			opts
		);
		return tree.tree.filter((e) => e.type === 'blob').map((e) => e.path);
	} catch (err) {
		// 409 is GitHub's answer for a repository with no commits yet.
		if (err instanceof GithubError && (err.status === 409 || err.status === 404)) return [];
		throw err;
	}
}

export function blobUrl(info: RepoInfo, path: string): string {
	return `${info.html_url}/blob/${encodeURIComponent(info.default_branch)}/${encodePath(path)}`;
}

export function projectFromBrief(slug: string, raw: string): ShelfProject {
	const { meta, body } = parseFrontmatter(raw);
	return {
		// The folder is the slug. A brief whose own `slug:` disagrees is a typo in
		// the brief, and the folder is what every path is built from.
		slug,
		title: fmString(meta.title) || headingOf(body) || slug,
		disciplines: [...new Set(fmList(meta.disciplines).map(normaliseDiscipline).filter(Boolean))],
		question: questionOf(body),
		board: fmString(meta.board),
		validationTier: fmString(meta.validation_tier),
		created: fmString(meta.created)
	};
}

export function normaliseDiscipline(d: string): string {
	return d
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

function headingOf(body: string): string {
	return /^#\s+(.+)$/m.exec(body)?.[1].trim() ?? '';
}

export function questionOf(body: string): string {
	const m = /^##\s+Question\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/m.exec(body);
	if (!m) return '';
	const text = m[1].replace(/<!--[\s\S]*?-->/g, '').trim();
	return text.split(/\n\s*\n/)[0].replace(/\s+/g, ' ').trim();
}

export async function listProjects(client: ShelfClient): Promise<ShelfProject[]> {
	const paths = await listPaths(client);
	const slugs = paths
		.map((p) => /^projects\/([^/]+)\/brief\.md$/.exec(p)?.[1])
		.filter((s): s is string => !!s && SLUG.test(s));
	const projects = await Promise.all(
		slugs.map(async (slug) => {
			const raw = await client.file(`projects/${slug}/brief.md`);
			return raw === null ? null : projectFromBrief(slug, raw);
		})
	);
	return projects.filter((p): p is ShelfProject => p !== null).sort((a, b) => a.title.localeCompare(b.title));
}

export interface DisciplineGroup {
	discipline: string;
	projects: ShelfProject[];
}

export const UNFILED = 'unfiled';

/**
 * One group per discipline, with a project listed under every one it names.
 *
 * The reason discipline is a tag and not a folder: an interdisciplinary project
 * belongs to both fields, and a folder would have to pick one.
 */
export function groupByDiscipline(projects: ShelfProject[]): DisciplineGroup[] {
	const groups = new Map<string, ShelfProject[]>();
	for (const p of projects) {
		for (const d of p.disciplines.length ? p.disciplines : [UNFILED]) {
			const list = groups.get(d) ?? [];
			list.push(p);
			groups.set(d, list);
		}
	}
	return [...groups.entries()]
		.sort(([a], [b]) => (a === UNFILED ? 1 : b === UNFILED ? -1 : a.localeCompare(b)))
		.map(([discipline, list]) => ({ discipline, projects: list }));
}

export async function getProject(client: ShelfClient, slug: string): Promise<ShelfProjectDetail | null> {
	if (!SLUG.test(slug)) return null;
	const briefPath = `projects/${slug}/brief.md`;
	const raw = await client.file(briefPath);
	if (raw === null) return null;
	const [info, paths] = await Promise.all([repoInfo(client), listPaths(client)]);
	const entry = (path: string): ShelfEntry => ({
		path,
		name: path.split('/').pop()!,
		url: blobUrl(info, path)
	});
	const under = (dir: string) =>
		paths.filter((p) => p.startsWith(`projects/${slug}/${dir}/`) && p.endsWith('.md')).sort();

	const claims = await Promise.all(
		under('claims').map(async (path): Promise<ShelfClaim> => {
			const text = (await client.file(path)) ?? '';
			const { meta, body } = parseFrontmatter(text);
			return {
				...entry(path),
				id: fmString(meta.id),
				title: headingOf(body),
				status: fmString(meta.status as FmValue) || 'unknown'
			};
		})
	);
	return {
		project: projectFromBrief(slug, raw),
		briefBody: parseFrontmatter(raw).body,
		briefUrl: blobUrl(info, briefPath),
		notes: under('notes').map(entry),
		claims
	};
}

/**
 * Create or overwrite one file as a commit on the default branch.
 *
 * The existing file's sha is read fresh rather than through the cache: a stale
 * sha is a 409, and a write is the one call that must see the current state.
 */
export async function writeShelfFile(
	client: ShelfClient,
	path: string,
	content: string,
	/** A string, or built once it is known whether the file already existed. */
	message: string | ((created: boolean) => string)
): Promise<{ commitUrl: string; created: boolean }> {
	let sha: string | undefined;
	try {
		sha = (await client.get<{ sha: string }>(`/contents/${encodePath(path)}`, { fresh: true })).sha;
	} catch (err) {
		if (!(err instanceof GithubError && err.status === 404)) throw err;
	}
	const res = await client.send<{ commit: { html_url: string } }>('PUT', `/contents/${encodePath(path)}`, {
		message: typeof message === 'string' ? message : message(!sha),
		content: Buffer.from(content, 'utf8').toString('base64'),
		...(sha ? { sha } : {})
	});
	return { commitUrl: res.commit.html_url, created: !sha };
}
