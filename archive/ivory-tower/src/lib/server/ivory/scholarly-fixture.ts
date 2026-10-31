/** A fetch that answers from a table of URL substrings, and records what was asked. */
export function routedFetch(routes: [string, () => Response][]) {
	const asked: { url: string; headers: Headers }[] = [];
	const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		asked.push({ url, headers: new Headers(init?.headers) });
		const hit = routes.find(([part]) => url.includes(part));
		return hit ? hit[1]() : new Response('{}', { status: 404 });
	}) as unknown as typeof fetch;
	return { impl, asked };
}
