import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/api';
import {
	createServer,
	listServers,
	listServerTools,
	McpConfigError
} from '$lib/server/engine/tools/mcp';

/** Never leak stored headers or env back to the browser — they carry tokens. */
function present(server: ReturnType<typeof listServers>[number]) {
	const { headersEnc, envEnc, ...rest } = server;
	return { ...rest, hasHeaders: Boolean(headersEnc), hasEnv: Boolean(envEnc) };
}

export const GET: RequestHandler = ({ locals }) => {
	requireAdmin(locals);
	const tools = listServerTools();
	return json(
		listServers().map((s) => ({
			...present(s),
			toolCount: tools.filter((t) => t.serverId === s.id).length
		}))
	);
};

export const POST: RequestHandler = async ({ locals, request }) => {
	requireAdmin(locals);
	const body = await request.json().catch(() => ({}));
	try {
		return json(present(createServer(body)), { status: 201 });
	} catch (err) {
		if (err instanceof McpConfigError) error(400, err.message);
		throw err;
	}
};
