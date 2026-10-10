import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { listCandidatesOf } from '$lib/server/engine/memory';
import { learningStatus, readingStatus, setLearning } from '$lib/server/engine/profile-learn';
import { listProposals, MAX_WAITING } from '$lib/server/profile';
import { profileSettings } from '$lib/server/settings';

/** What is waiting for the caller, and where learning from their conversations has got to. */
export const GET: RequestHandler = ({ locals }) => {
	const user = requireUser(locals);
	const cfg = profileSettings();
	const status = learningStatus(user.id);
	return json({
		proposals: listProposals(user.id),
		candidates: listCandidatesOf(user.id).map((c) => ({
			id: c.id,
			name: c.name,
			description: c.description,
			rationale: c.rationale,
			tasks: c.tasks,
			body: c.body,
			status: c.status,
			createdAt: c.createdAt
		})),
		enabled: status.enabled,
		scheduleEnabled: cfg.enabled,
		intervalHours: cfg.intervalHours,
		lastRun: status.lastRun,
		nextDue: status.lastRun + cfg.intervalHours * 3_600_000,
		reading: readingStatus(user.id),
		maxWaiting: MAX_WAITING
	});
};

/** The caller's own switch: whether their conversations are read at all. */
export const PUT: RequestHandler = async ({ locals, request }) => {
	const user = requireUser(locals);
	const body = await request.json().catch(() => ({}));
	if (typeof body.enabled !== 'boolean') error(400, 'enabled must be a boolean');
	setLearning(user.id, body.enabled);
	return json({ enabled: body.enabled });
};
