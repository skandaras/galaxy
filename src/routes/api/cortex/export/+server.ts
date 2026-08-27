import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { exportPayload } from '$lib/server/cortex';

export const GET: RequestHandler = ({ locals }) => {
	const user = requireUser(locals);
	// Scoped like every other read: their own concepts plus anything shared.
	return json(exportPayload(user.id), {
		headers: { 'content-disposition': 'attachment; filename="cortex.json"' }
	});
};
