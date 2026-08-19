import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAlignment } from '$lib/server/api';
import { listSyntheses } from '$lib/server/alignment';
import { getSynthesisStatus } from '$lib/server/engine/alignment';
import { DEFAULT_ALIGNMENT, getSetting, type AlignmentSettings } from '$lib/server/settings';

export const GET: RequestHandler = ({ locals }) => {
	const user = requireAlignment(locals);
	const cfg = getSetting<AlignmentSettings>('alignment', DEFAULT_ALIGNMENT);
	const { lastRun } = getSynthesisStatus(user.id);
	return json({
		syntheses: listSyntheses(user.id),
		lastRun,
		nextDue: lastRun + cfg.synthesisIntervalHours * 3_600_000
	});
};
