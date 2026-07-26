import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { getMemoryStatus, listCandidates, listMemoryItems } from '$lib/server/engine/memory';
import { DEFAULT_MEMORY, getSetting, type MemorySettings } from '$lib/server/settings';

// A user's own memory: items, status, and the candidates their activity
// proposed (visible for transparency; approval stays with an admin).
export const GET: RequestHandler = ({ locals }) => {
	const user = requireUser(locals);
	const global = getSetting<MemorySettings>('memory', DEFAULT_MEMORY);
	const status = getMemoryStatus(user.id);
	return json({
		items: listMemoryItems(user.id),
		enabled: status.enabled,
		lastRun: status.lastRun,
		nextDue: status.lastRun + global.intervalHours * 3_600_000,
		scheduleEnabled: global.enabled,
		intervalHours: global.intervalHours,
		myCandidates: listCandidates()
			.filter((c) => c.userId === user.id)
			.map((c) => ({
				id: c.id,
				name: c.name,
				description: c.description,
				status: c.status,
				createdAt: c.createdAt
			}))
	});
};
