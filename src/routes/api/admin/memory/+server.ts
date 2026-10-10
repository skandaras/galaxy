import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/api';
import { db } from '$lib/server/db';
import { users } from '$lib/server/db/schema';
import { listCandidates } from '$lib/server/engine/memory';
import { learningStatusByUser } from '$lib/server/engine/profile-learn';
import { profileSettings } from '$lib/server/settings';

/**
 * Platform-level administration of learning and skills.
 *
 * A person's profile belongs to them and is deliberately NOT exposed here: no
 * claim crosses this boundary, only counts and timings. Skill candidates are
 * the one exception: approving a global skill requires reading it, so they are
 * attributed by username rather than hidden.
 */
export const GET: RequestHandler = ({ locals }) => {
	requireAdmin(locals);
	const cfg = profileSettings();
	const usernames = new Map(db.select().from(users).all().map((u) => [u.id, u.username]));

	return json({
		userStatus: learningStatusByUser().map((s) => ({
			...s,
			nextDue: s.lastRun + cfg.intervalHours * 3_600_000
		})),
		candidates: listCandidates().map((c) => ({
			...c,
			proposedBy: c.userId ? (usernames.get(c.userId) ?? 'unknown') : 'skill optimiser'
		}))
	});
};
