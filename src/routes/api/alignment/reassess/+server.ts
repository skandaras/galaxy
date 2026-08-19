import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAlignment } from '$lib/server/api';
import { latestAssessments, listEntries } from '$lib/server/alignment';
import { reassessEntries } from '$lib/server/engine/alignment';
import { DEFAULT_ALIGNMENT, getSetting, type AlignmentSettings } from '$lib/server/settings';

/**
 * What a re-assessment would cover, so the cost is visible before it is spent.
 * Only entries that already have a reading: re-assessing something never read is
 * just assessing it, and there would be nothing to compare against.
 */
export const GET: RequestHandler = ({ locals }) => {
	const user = requireAlignment(locals);
	const cfg = getSetting<AlignmentSettings>('alignment', DEFAULT_ALIGNMENT);
	const assessed = new Set(latestAssessments(user.id, 200).map((a) => a.entryId));
	const candidates = listEntries(user.id)
		.filter((e) => assessed.has(e.id) && !e.skipAssessment)
		.slice(0, cfg.maxReassessPerRun);
	return json({
		max: cfg.maxReassessPerRun,
		candidates: candidates.map((e) => ({
			id: e.id,
			title: e.title,
			createdAt: e.createdAt
		}))
	});
};

export const POST: RequestHandler = async ({ locals, request }) => {
	const user = requireAlignment(locals);
	const body = await request.json().catch(() => ({}));
	if (!Array.isArray(body.entryIds) || !body.entryIds.length) {
		error(400, 'entryIds is required');
	}
	const ids = body.entryIds.filter((id: unknown) => typeof id === 'string');
	return json(await reassessEntries(user.id, ids));
};
