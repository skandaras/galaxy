import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAlignment } from '$lib/server/api';
import {
	DISENGAGEMENT_MECHANISMS,
	RUBRIC_DIMENSIONS,
	RUBRIC_VERSION,
	getRubricPrefs
} from '$lib/server/alignment-rubric';

/**
 * The whole rubric, definitions and anchors included. Something measuring your
 * character has no business being unreadable by the person it measures.
 */
export const GET: RequestHandler = ({ locals }) => {
	const user = requireAlignment(locals);
	return json({
		version: RUBRIC_VERSION,
		dimensions: RUBRIC_DIMENSIONS,
		mechanisms: DISENGAGEMENT_MECHANISMS,
		prefs: getRubricPrefs(user.id)
	});
};
