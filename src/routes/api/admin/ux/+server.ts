import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/api';
import { getUxStatus, listUxIdeas } from '$lib/server/engine/ux-audit';
import { isProd } from '$lib/server/engine/scheduler';
import {
	DEFAULT_RETENTION,
	DEFAULT_UX_AUDIT,
	getSetting,
	type RetentionSettings,
	type UxAuditSettings
} from '$lib/server/settings';

/**
 * The UX backlog. Admin-only, like every other platform-level surface — and
 * safe to expose in full: the auditor only ever sees aggregated telemetry and
 * the interface source, so nothing here can carry conversation content.
 */
export const GET: RequestHandler = ({ locals }) => {
	requireAdmin(locals);
	const settings = getSetting<UxAuditSettings>('uxaudit', DEFAULT_UX_AUDIT);
	const retention = getSetting<RetentionSettings>('retention', DEFAULT_RETENTION);
	const status = getUxStatus();
	return json({
		settings,
		// Dev and prod are separate containers with separate volumes, so these are
		// already two unrelated backlogs. Naming the instance is what stops them
		// being mistaken for one; `pruneDays` says how long this one keeps ideas.
		environment: env.GALAXY_ENV || 'dev',
		pruneDays: isProd() ? 0 : retention.uxIdeaDays,
		lastRun: status.lastRun,
		nextDue: status.lastRun + settings.intervalHours * 3_600_000,
		ideas: listUxIdeas().map((i) => ({
			...i,
			createdAt: i.createdAt.getTime(),
			decidedAt: i.decidedAt?.getTime() ?? null
		}))
	});
};
