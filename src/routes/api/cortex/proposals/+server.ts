import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { listProposals } from '$lib/server/engine/cortex-groom';

export const GET: RequestHandler = ({ locals, url }) => {
	const user = requireUser(locals);
	// Scoped to this person's own lattice: the groomer never proposes across an
	// ownership boundary, so there is nothing else to show them.
	return json(listProposals(user.id, url.searchParams.get('all') ? 'all' : 'open'));
};
