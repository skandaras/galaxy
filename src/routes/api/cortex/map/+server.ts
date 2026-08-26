import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { mapProjection } from '$lib/server/cortex';

export const GET: RequestHandler = ({ locals }) => {
	const user = requireUser(locals);
	// A visualisation is the easiest place in the world to render the whole
	// table by accident, so this goes through the same scoped projection the
	// privacy tests cover rather than reading the tables directly.
	return json(mapProjection(user.id));
};
