import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import {
	memoryCap,
	getMemoryStatus,
	listCandidates,
	listMemoryItems,
	listProposals,
	rebuildStatus
} from '$lib/server/engine/memory';
import { DEFAULT_MEMORY, getSetting, type MemorySettings } from '$lib/server/settings';

// A user's own memory: items, what is waiting for their approval, status, and
// the skill candidates their activity proposed.
export const GET: RequestHandler = ({ locals }) => {
	const user = requireUser(locals);
	const global = getSetting<MemorySettings>('memory', DEFAULT_MEMORY);
	const status = getMemoryStatus(user.id);
	return json({
		items: listMemoryItems(user.id),
		proposals: listProposals(user.id, 'pending'),
		cap: memoryCap(),
		enabled: status.enabled,
		lastRun: status.lastRun,
		nextDue: status.lastRun + global.intervalHours * 3_600_000,
		scheduleEnabled: global.enabled,
		intervalHours: global.intervalHours,
		rebuild: rebuildStatus(user.id),
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
