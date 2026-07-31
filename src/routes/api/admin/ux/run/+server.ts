import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/api';
import { runUxAudit } from '$lib/server/engine/ux-audit';

/** Run the audit on demand, rather than waiting for the weekly tick. */
export const POST: RequestHandler = async ({ locals }) => {
	requireAdmin(locals);
	return json(await runUxAudit('manual'));
};
