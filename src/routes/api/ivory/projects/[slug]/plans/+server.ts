import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireCoder } from '$lib/server/api';
import { listProposals } from '$lib/server/ivory/plan';
import { ivorySettings } from '$lib/server/settings';

// The caller's plans for this project that are waiting on a decision.
export const GET: RequestHandler = ({ locals, params }) => {
	const user = requireCoder(locals);
	return json(listProposals(user.id, ivorySettings().shelfRepo, params.slug));
};
