import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { profileWrite, requireUser } from '$lib/server/api';
import { cleanDraft, confirmDraft } from '$lib/server/profile';

/** Save a reviewed draft: all of it, or none of it and every refusal by line. */
export const POST: RequestHandler = async ({ locals, request }) => {
	const user = requireUser(locals);
	const body = await request.json().catch(() => ({}));
	if (body.source !== 'survey' && body.source !== 'imported') error(400, 'source is survey or imported');
	const result = profileWrite(() => confirmDraft(user.id, cleanDraft(body.draft), body.source));
	if (!result.ok) {
		const n = result.refusals.length;
		return json(
			{ message: `Nothing was saved: ${n} ${n === 1 ? 'line needs' : 'lines need'} changing first.`, refusals: result.refusals },
			{ status: 400 }
		);
	}
	return json(result);
};
