import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/api';
import { runMemory, runSkillOptimiser } from '$lib/server/engine/memory';

export const POST: RequestHandler = async ({ locals, url }) => {
	requireAdmin(locals);
	const result =
		url.searchParams.get('kind') === 'optimise'
			? await runSkillOptimiser()
			: await runMemory('manual');
	return json(result);
};
