import { json } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/api';
import { db } from '$lib/server/db';
import { users } from '$lib/server/db/schema';
import { listCandidates, memoryStatusByUser } from '$lib/server/engine/memory';
import { DEFAULT_MEMORY, getSetting } from '$lib/server/settings';

/**
 * Platform-level memory administration only.
 *
 * Memory items belong to their owner and are deliberately NOT exposed here —
 * no `content` field crosses this boundary, only counts and timings. Skill
 * candidates are the one exception: approving a global skill requires reading
 * it, so they are attributed by username rather than hidden.
 */
export const GET: RequestHandler = ({ locals }) => {
	requireAdmin(locals);
	const settings = getSetting('memory', DEFAULT_MEMORY);
	const usernames = new Map(db.select().from(users).all().map((u) => [u.id, u.username]));

	return json({
		settings,
		userStatus: memoryStatusByUser().map((s) => ({
			...s,
			nextDue: s.lastRun + settings.intervalHours * 3_600_000
		})),
		candidates: listCandidates().map((c) => ({
			...c,
			proposedBy: c.userId ? (usernames.get(c.userId) ?? 'unknown') : 'skill optimiser'
		}))
	});
};
