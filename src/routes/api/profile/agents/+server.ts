import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { agentBlocks } from '$lib/server/profile';

/** Exactly what each agent is given, so the person can check it rather than trust it. */
export const GET: RequestHandler = ({ locals }) => {
	const user = requireUser(locals);
	return json({ blocks: agentBlocks(user.id) });
};
