import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/api';
import {
	getMemoryStatus,
	listCandidates,
	listMemoryItems
} from '$lib/server/engine/memory';
import { DEFAULT_MEMORY, getSetting } from '$lib/server/settings';

export const GET: RequestHandler = ({ locals }) => {
	requireAdmin(locals);
	const settings = getSetting('memory', DEFAULT_MEMORY);
	const status = getMemoryStatus();
	return json({
		settings,
		...status,
		nextDue: status.lastRun + settings.intervalHours * 3_600_000,
		items: listMemoryItems(),
		candidates: listCandidates()
	});
};
