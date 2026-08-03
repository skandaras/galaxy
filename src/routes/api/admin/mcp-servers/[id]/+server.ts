import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/api';
import {
	deleteServer,
	getServer,
	McpConfigError,
	updateServer
} from '$lib/server/engine/tools/mcp';

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	requireAdmin(locals);
	if (!getServer(params.id)) error(404, 'Server not found');
	const body = await request.json().catch(() => ({}));
	try {
		const { headersEnc, envEnc, ...rest } = updateServer(params.id, body);
		return json({ ...rest, hasHeaders: Boolean(headersEnc), hasEnv: Boolean(envEnc) });
	} catch (err) {
		if (err instanceof McpConfigError) error(400, err.message);
		throw err;
	}
};

export const DELETE: RequestHandler = ({ locals, params }) => {
	requireAdmin(locals);
	if (!getServer(params.id)) error(404, 'Server not found');
	deleteServer(params.id);
	return json({ ok: true });
};
