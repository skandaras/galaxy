import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { getLiveJob } from '$lib/server/engine/jobs';
import { answerPermission } from '$lib/server/engine/permissions';

/**
 * Answer a tool-permission request a run is parked on. The decision is checked
 * against the four fixed values in answerPermission, so a client cannot invent
 * a wider grant than the sheet offers.
 */
export const POST: RequestHandler = async ({ locals, params, request }) => {
	const user = requireUser(locals);
	const job = getLiveJob(params.id);
	// Same shape as an unknown job, so a job id can't be probed for existence.
	if (!job || job.userId !== user.id) error(404, 'Job not found');

	const body = await request.json().catch(() => ({}));
	const requestId = typeof body.requestId === 'string' ? body.requestId : '';
	if (!requestId) error(400, 'requestId is required');

	// False is a lost race (already answered, run stopped), not an error.
	return json({ answered: answerPermission(requestId, user.id, body.decision) });
};
