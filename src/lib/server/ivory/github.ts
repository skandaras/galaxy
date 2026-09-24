import { githubToken } from '$lib/server/engine/coding/workspace';
import { ivorySettings } from '$lib/server/settings';

/**
 * The GitHub REST calls Ivory Tower makes, all against one repository: the Shelf.
 *
 * Its own client rather than a fifth inline `fetch`, because the Shelf is read
 * on every page view. Each view is a tree listing, a brief per project and a
 * page of issues, and uncached that is a dozen calls per click against a
 * 5,000-an-hour allowance shared with the coding agent. GETs are kept for a
 * minute, which is also the most a closed issue can lag behind in the view.
 */

export const SHELF_CACHE_MS = 60_000;
const CACHE_MAX = 500;

export class GithubError extends Error {
	constructor(
		readonly status: number,
		message: string
	) {
		super(message);
		this.name = 'GithubError';
	}
}

export interface ShelfClientOptions {
	repo: string;
	token: string;
	/** Injected in tests so no suite ever depends on the network. */
	fetchImpl?: typeof fetch;
	now?: () => number;
	ttlMs?: number;
}

interface Cached {
	at: number;
	value: unknown;
}

export interface ShelfClient {
	readonly repo: string;
	/** JSON from `/repos/<repo><path>`, cached unless `fresh`. */
	get<T>(path: string, opts?: { fresh?: boolean }): Promise<T>;
	/** A file's text from the default branch, cached unless `fresh`; null when it does not exist. */
	file(path: string, opts?: { fresh?: boolean }): Promise<string | null>;
	/** A write. Clears the cache: whatever it changed should show on the next read. */
	send<T>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T>;
	/** Fetch a list endpoint page by page, up to `maxPages`. */
	paged<T>(path: string, opts?: { fresh?: boolean; maxPages?: number }): Promise<T[]>;
}

export function createShelfClient(opts: ShelfClientOptions): ShelfClient {
	const doFetch = opts.fetchImpl ?? fetch;
	const now = opts.now ?? Date.now;
	const ttl = opts.ttlMs ?? SHELF_CACHE_MS;
	const cache = new Map<string, Cached>();

	const request = async (method: string, path: string, init: { body?: unknown; accept?: string } = {}) => {
		const res = await doFetch(`https://api.github.com/repos/${opts.repo}${path}`, {
			method,
			headers: {
				authorization: `Bearer ${opts.token}`,
				accept: init.accept ?? 'application/vnd.github+json',
				'content-type': 'application/json',
				'user-agent': 'galaxy',
				'x-github-api-version': '2022-11-28'
			},
			body: init.body === undefined ? undefined : JSON.stringify(init.body),
			signal: AbortSignal.timeout(20_000)
		});
		return res;
	};

	const fail = async (res: Response, what: string): Promise<never> => {
		const data = (await res.json().catch(() => ({}))) as { message?: string };
		throw new GithubError(res.status, `${what}: GitHub answered ${res.status}${data.message ? ` (${data.message})` : ''}`);
	};

	const cached = async <T>(key: string, fresh: boolean | undefined, load: () => Promise<T>): Promise<T> => {
		const hit = cache.get(key);
		if (!fresh && hit && now() - hit.at < ttl) return hit.value as T;
		const value = await load();
		cache.delete(key);
		cache.set(key, { at: now(), value });
		// Oldest first: Map keeps insertion order and a refresh re-inserts.
		while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
		return value;
	};

	const client: ShelfClient = {
		repo: opts.repo,
		get: (path, o = {}) =>
			cached(`GET ${path}`, o.fresh, async () => {
				const res = await request('GET', path);
				if (!res.ok) await fail(res, `GET ${path}`);
				return res.json();
			}),
		file: (path, o = {}) =>
			cached(`FILE ${path}`, o.fresh, async () => {
				const res = await request('GET', `/contents/${encodePath(path)}`, {
					accept: 'application/vnd.github.raw+json'
				});
				if (res.status === 404) return null;
				if (!res.ok) await fail(res, `read ${path}`);
				return res.text();
			}),
		send: async (method, path, body) => {
			const res = await request(method, path, { body });
			cache.clear();
			if (!res.ok) await fail(res, `${method} ${path}`);
			return (res.status === 204 ? null : await res.json()) as never;
		},
		paged: async <T>(path: string, o: { fresh?: boolean; maxPages?: number } = {}) => {
			const out: T[] = [];
			const sep = path.includes('?') ? '&' : '?';
			for (let page = 1; page <= (o.maxPages ?? 10); page++) {
				const rows = await client.get<T[]>(`${path}${sep}per_page=100&page=${page}`, o);
				out.push(...rows);
				if (rows.length < 100) break;
			}
			return out;
		}
	};
	return client;
}

/** Each segment encoded, the slashes kept. */
export function encodePath(path: string): string {
	return path.split('/').map(encodeURIComponent).join('/');
}

let shared: { key: string; client: ShelfClient } | null = null;

/**
 * The client for the configured Shelf, or null when there is no token yet.
 *
 * Kept while the repository and token stay the same, so the cache outlives a
 * single request; rebuilt the moment either changes in Admin.
 */
export function shelfClient(): ShelfClient | null {
	const token = githubToken();
	if (!token) return null;
	const repo = ivorySettings().shelfRepo;
	const key = `${repo}\n${token}`;
	if (shared?.key !== key) shared = { key, client: createShelfClient({ repo, token }) };
	return shared.client;
}
