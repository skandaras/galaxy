import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser, sseResponse } from '$lib/server/api';
import { getLiveJob, subscribeJob } from '$lib/server/engine/jobs';

export const GET: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	const job = getLiveJob(params.id);
	if (!job || job.userId !== user.id) error(404, 'Job not found');

	return sseResponse(({ send, close }) => {
		const unsubscribe = subscribeJob(job, (chunk) => {
			send(chunk);
			if (chunk.type === 'done' || chunk.type === 'error') close();
		});
		return unsubscribe;
	});
};
