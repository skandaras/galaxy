import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAlignment } from '$lib/server/api';
import { listConstitutionVersions } from '$lib/server/alignment';

/** The timeline of what the agent has been judging against, newest first. */
export const GET: RequestHandler = ({ locals }) => {
	const user = requireAlignment(locals);
	return json({ versions: listConstitutionVersions(user.id) });
};
