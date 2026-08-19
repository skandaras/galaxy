import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import {
	ALIGNMENT_ENABLED_KEY,
	DEFAULT_ALIGNMENT,
	getSetting,
	setSetting,
	type AlignmentSettings
} from '$lib/server/settings';
import { DEFAULT_RUBRIC_PREFS, getRubricPrefs, setRubricPrefs } from '$lib/server/alignment-rubric';

/**
 * Deliberately `requireUser` rather than `requireAlignment`: this is the switch
 * that turns the feature on, so gating it on the feature being on would leave
 * nobody able to reach it.
 */
export const GET: RequestHandler = ({ locals }) => {
	const user = requireUser(locals);
	const platform = getSetting<AlignmentSettings>('alignment', DEFAULT_ALIGNMENT);
	return json({
		enabled: getSetting<boolean>(ALIGNMENT_ENABLED_KEY, false, user.id),
		platformEnabled: platform.enabled,
		synthesisIntervalHours: platform.synthesisIntervalHours,
		lastSynthesisAt: getSetting<number>('alignment.synthesis.lastRun', 0, user.id),
		rubric: getRubricPrefs(user.id)
	});
};

export const PUT: RequestHandler = async ({ locals, request }) => {
	const user = requireUser(locals);
	const body = await request.json().catch(() => ({}));

	if (body.enabled !== undefined) {
		if (typeof body.enabled !== 'boolean') error(400, 'enabled must be a boolean');
		if (body.enabled && !getSetting<AlignmentSettings>('alignment', DEFAULT_ALIGNMENT).enabled) {
			error(403, 'Alignment is switched off for this instance');
		}
		setSetting(ALIGNMENT_ENABLED_KEY, body.enabled, user.id);
	}

	if (body.rubric !== undefined) {
		// Normalised server-side: the form is not the only way in here.
		setRubricPrefs(user.id, body.rubric ?? DEFAULT_RUBRIC_PREFS);
	}

	return json({
		enabled: getSetting<boolean>(ALIGNMENT_ENABLED_KEY, false, user.id),
		rubric: getRubricPrefs(user.id)
	});
};
