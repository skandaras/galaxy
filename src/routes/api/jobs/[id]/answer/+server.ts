import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { answerQuestion } from '$lib/server/engine/ask-user';
import { getLiveJob } from '$lib/server/engine/jobs';

/**
 * Answer a question an agent asked mid-turn. The waiting tool call resolves
 * with this text and the run carries on.
 */
export const POST: RequestHandler = async ({ locals, params, request }) => {
	const user = requireUser(locals);
	const job = getLiveJob(params.id);
	// Same shape as an unknown job, so a job id can't be probed for existence.
	if (!job || job.userId !== user.id) error(404, 'Job not found');

	const body = await request.json().catch(() => ({}));
	const questionId = typeof body.questionId === 'string' ? body.questionId : '';
	const answer = typeof body.answer === 'string' ? body.answer.trim() : '';
	if (!questionId) error(400, 'questionId is required');
	if (!answer) error(400, 'answer is required');

	// A question that timed out or was already answered is not an error — the
	// client has simply lost the race, and the stream already says so.
	return json({ answered: answerQuestion(questionId, user.id, answer) });
};
