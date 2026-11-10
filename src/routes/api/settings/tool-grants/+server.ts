import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { listGrants, revokeGrant } from '$lib/server/engine/permissions';

/** The tools this person has allowed everywhere, for the Settings card. */
export const GET: RequestHandler = ({ locals }) => {
	const user = requireUser(locals);
	return json({ grants: listGrants(user.id) });
};

/** Take back one "always allow", by the tool's key. */
export const DELETE: RequestHandler = ({ locals, url }) => {
	const user = requireUser(locals);
	const key = url.searchParams.get('key');
	if (!key) error(400, 'key is required');
	return json({ revoked: revokeGrant(user.id, key) });
};
