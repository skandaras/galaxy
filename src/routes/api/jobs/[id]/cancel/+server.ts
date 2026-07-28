import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { cancelJob, getLiveJob } from '$lib/server/engine/jobs';

/**
 * Stop a running turn. The loop winds down at its next check and keeps whatever
 * the model produced, so this returns immediately rather than waiting for the
 * run to finish.
 */
export const POST: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	const job = getLiveJob(params.id);
	// Same shape as an unknown job, so a job id can't be probed for existence.
	if (!job || job.userId !== user.id) error(404, 'Job not found');

	// Already finished is not an error — the user's intent is satisfied either
	// way, and the client may just have raced the final chunk.
	return json({ cancelled: cancelJob(job), status: job.status });
};
