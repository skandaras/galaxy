import { createShelfClient, type ShelfClient } from './github';

/**
 * A GitHub that lives in a Map, for the Ivory suites.
 *
 * Answers only the endpoints the Shelf uses, the way GitHub answers them, so a
 * test can close an issue or add a file between two reads and see what the
 * view makes of it. Every request is recorded, which is how a suite asserts
 * that something was *not* written.
 */

export interface FakeIssue {
	id: number;
	number: number;
	title: string;
	body: string;
	state: 'open' | 'closed';
	labels: string[];
	pull?: boolean;
}

export interface FakeGithub {
	repo: string;
	files: Map<string, string>;
	issues: FakeIssue[];
	labels: Set<string>;
	comments: { issue: number; body: string }[];
	subIssues: { parent: number; child: number }[];
	commits: { path: string; message: string }[];
	requests: { method: string; path: string; body?: unknown }[];
	/** Clock for the client's cache, moved by the test. */
	clock: { now: number };
	client: ShelfClient;
	addIssue(i: Partial<FakeIssue> & { title: string; labels: string[] }): FakeIssue;
}

export function fakeGithub(repo = 'owner/shelf', opts: { empty?: boolean } = {}): FakeGithub {
	const gh = {
		repo,
		files: new Map<string, string>(),
		issues: [] as FakeIssue[],
		labels: new Set<string>(),
		comments: [] as { issue: number; body: string }[],
		subIssues: [] as { parent: number; child: number }[],
		commits: [] as { path: string; message: string }[],
		requests: [] as { method: string; path: string; body?: unknown }[],
		clock: { now: 1_000_000 }
	} as FakeGithub;
	let nextNumber = 1;
	let empty = opts.empty ?? false;

	gh.addIssue = (i) => {
		const issue: FakeIssue = {
			id: 9000 + nextNumber,
			number: nextNumber++,
			body: '',
			state: 'open',
			...i
		};
		gh.issues.push(issue);
		return issue;
	};

	const reply = (status: number, body: unknown) =>
		new Response(typeof body === 'string' ? body : JSON.stringify(body), {
			status,
			headers: { 'content-type': typeof body === 'string' ? 'text/plain' : 'application/json' }
		});
	const rawIssue = (i: FakeIssue) => ({
		id: i.id,
		number: i.number,
		title: i.title,
		body: i.body,
		html_url: `https://github.com/${repo}/issues/${i.number}`,
		state: i.state,
		labels: i.labels.map((name) => ({ name })),
		...(i.pull ? { pull_request: {} } : {})
	});

	const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		const method = init?.method ?? 'GET';
		const prefix = `/repos/${repo}`;
		if (!url.pathname.startsWith(prefix)) return reply(404, { message: 'Not Found' });
		const path = url.pathname.slice(prefix.length);
		const body = init?.body ? JSON.parse(String(init.body)) : undefined;
		gh.requests.push({ method, path: path + url.search, body });
		const page = Number(url.searchParams.get('page') ?? 1);
		const perPage = Number(url.searchParams.get('per_page') ?? 30);
		const paginate = <T>(rows: T[]) => rows.slice((page - 1) * perPage, page * perPage);

		if (method === 'GET' && path === '') {
			return reply(200, { default_branch: 'main', html_url: `https://github.com/${repo}` });
		}
		if (method === 'GET' && path.startsWith('/git/trees/')) {
			if (empty) return reply(409, { message: 'Git Repository is empty.' });
			return reply(200, { tree: [...gh.files.keys()].map((p) => ({ path: p, type: 'blob' })) });
		}
		const contents = /^\/contents\/(.+)$/.exec(path);
		if (contents) {
			const file = decodeURIComponent(contents[1]);
			if (method === 'GET') {
				const text = gh.files.get(file);
				if (text === undefined) return reply(404, { message: 'Not Found' });
				const accept = new Headers(init?.headers).get('accept') ?? '';
				return accept.includes('raw') ? reply(200, text) : reply(200, { sha: `sha-${file}-${text.length}` });
			}
			if (method === 'PUT') {
				const exists = gh.files.has(file);
				if (exists && !body.sha) return reply(422, { message: 'sha wasn’t supplied' });
				gh.files.set(file, Buffer.from(body.content, 'base64').toString('utf8'));
				gh.commits.push({ path: file, message: body.message });
				empty = false;
				return reply(exists ? 200 : 201, {
					commit: { html_url: `https://github.com/${repo}/commit/${gh.commits.length}` }
				});
			}
		}
		if (path === '/issues' && method === 'GET') {
			const state = url.searchParams.get('state') ?? 'open';
			return reply(200, paginate(gh.issues.filter((i) => state === 'all' || i.state === state).map(rawIssue)));
		}
		if (path === '/issues' && method === 'POST') {
			for (const l of body.labels ?? []) gh.labels.add(l);
			return reply(201, rawIssue(gh.addIssue({ title: body.title, body: body.body, labels: body.labels ?? [] })));
		}
		const one = /^\/issues\/(\d+)$/.exec(path);
		if (one && method === 'GET') {
			const i = gh.issues.find((x) => x.number === Number(one[1]));
			return i ? reply(200, rawIssue(i)) : reply(404, { message: 'Not Found' });
		}
		const comment = /^\/issues\/(\d+)\/comments$/.exec(path);
		if (comment && method === 'POST') {
			gh.comments.push({ issue: Number(comment[1]), body: body.body });
			return reply(201, { html_url: `https://github.com/${repo}/issues/${comment[1]}#c${gh.comments.length}` });
		}
		const sub = /^\/issues\/(\d+)\/sub_issues$/.exec(path);
		if (sub && method === 'POST') {
			gh.subIssues.push({ parent: Number(sub[1]), child: body.sub_issue_id });
			return reply(201, {});
		}
		if (path === '/labels' && method === 'GET') {
			return reply(200, paginate([...gh.labels].map((name) => ({ name }))));
		}
		if (path === '/labels' && method === 'POST') {
			if (gh.labels.has(body.name)) return reply(422, { message: 'already_exists' });
			gh.labels.add(body.name);
			return reply(201, { name: body.name });
		}
		return reply(404, { message: `fake github has no ${method} ${path}` });
	}) as unknown as typeof fetch;

	gh.client = createShelfClient({ repo, token: 't', fetchImpl: impl, now: () => gh.clock.now });
	return gh;
}

export const SAMPLE_BRIEF = `---
slug: bees-and-queues
title: "Waggle dances as load balancing"
disciplines: [entomology, operations-research]  # two fields, one project
board: ""
validation_tier: reading
created: 2026-09-01
---
<!-- No status field. Status lives on the board only. -->

# Waggle dances as load balancing

## Question
<!-- One sentence. -->
Do honeybee recruitment dances allocate foragers the way a load balancer allocates requests?

## Why this might be new
A hunch.
`;
