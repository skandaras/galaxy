import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/api';
import { runSkillOptimiser } from '$lib/server/engine/skill-optimiser';

/**
 * Skill-optimiser only. There is intentionally no admin route to run someone
 * else's learning job: a run reads that user's chats, so it stays theirs to
 * trigger (POST /api/profile/learning/run) or the scheduler's.
 */
export const POST: RequestHandler = async ({ locals }) => {
	const admin = requireAdmin(locals);
	return json(await runSkillOptimiser(admin.id));
};
