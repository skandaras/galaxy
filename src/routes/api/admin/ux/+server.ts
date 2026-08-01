import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/api';
import { getUxStatus, listUxIdeas } from '$lib/server/engine/ux-audit';
import { DEFAULT_UX_AUDIT, getSetting, type UxAuditSettings } from '$lib/server/settings';

/**
 * The UX backlog. Admin-only, like every other platform-level surface — and
 * safe to expose in full: the auditor only ever sees aggregated telemetry and
 * the interface source, so nothing here can carry conversation content.
 */
export const GET: RequestHandler = ({ locals }) => {
	requireAdmin(locals);
	const settings = getSetting<UxAuditSettings>('uxaudit', DEFAULT_UX_AUDIT);
	const status = getUxStatus();
	return json({
		settings,
		lastRun: status.lastRun,
		nextDue: status.lastRun + settings.intervalHours * 3_600_000,
		ideas: listUxIdeas().map((i) => ({
			...i,
			createdAt: i.createdAt.getTime(),
			decidedAt: i.decidedAt?.getTime() ?? null
		}))
	});
};
