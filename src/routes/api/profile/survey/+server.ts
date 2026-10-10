import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { mergeDrafts } from '$lib/profile-draft';
import { readAnswers, surveyDraft } from '$lib/survey';
import { parseIntoDraft } from '$lib/server/engine/profile-parse';
import { ProfileError } from '$lib/server/profile';

/** The survey's answers as a draft for review. Nothing is saved here. */
export const POST: RequestHandler = async ({ locals, request }) => {
	const user = requireUser(locals);
	const body = await request.json().catch(() => ({}));
	const { draft, parts } = surveyDraft(readAnswers(body.answers));
	if (!parts.length) return json(draft);
	try {
		return json(mergeDrafts(draft, await parseIntoDraft(user.id, parts)));
	} catch (err) {
		if (!(err instanceof ProfileError)) throw err;
		// The short answers still make a draft. Refusing the whole survey because
		// no model is set would leave the person with nothing to save at all.
		draft.leftOut.push(
			`Your longer answers were not sorted: ${err.message} Go back to change them, or add them on the Profile page later.`
		);
		return json(draft);
	}
};
