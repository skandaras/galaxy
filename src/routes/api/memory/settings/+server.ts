import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { setUserMemoryEnabled } from '$lib/server/engine/memory';

/** Own opt-out only. The cadence itself stays a platform-level admin setting. */
export const PUT: RequestHandler = async ({ locals, request }) => {
	const user = requireUser(locals);
	const body = await request.json().catch(() => ({}));
	if (typeof body.enabled !== 'boolean') error(400, 'enabled must be a boolean');
	setUserMemoryEnabled(user.id, body.enabled);
	return json({ enabled: body.enabled });
};
