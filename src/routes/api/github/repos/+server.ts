import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { githubToken } from '$lib/server/engine/coding/workspace';

// Repos visible to the configured GitHub token, for the Code page dropdown.
export const GET: RequestHandler = async ({ locals }) => {
	requireUser(locals);
	const token = githubToken();
	if (!token) return json({ configured: false, repos: [] });

	const res = await fetch(
		'https://api.github.com/user/repos?per_page=100&sort=pushed',
		{
			headers: {
				authorization: `Bearer ${token}`,
				accept: 'application/vnd.github+json',
				'user-agent': 'galaxy'
			},
			signal: AbortSignal.timeout(15_000)
		}
	);
	if (!res.ok) error(502, `GitHub listing failed: ${res.status}`);
	const rows: { full_name: string; clone_url: string; private: boolean }[] = await res.json();
	return json({
		configured: true,
		repos: rows.map((r) => ({
			fullName: r.full_name,
			cloneUrl: r.clone_url,
			private: r.private
		}))
	});
};
