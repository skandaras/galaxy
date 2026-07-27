import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/api';
import { getServer, syncServer } from '$lib/server/engine/tools/mcp';

/** Connect and re-discover the server's tools; doubles as the Test action. */
export const POST: RequestHandler = async ({ locals, params }) => {
	requireAdmin(locals);
	if (!getServer(params.id)) error(404, 'Server not found');
	return json(await syncServer(params.id));
};
