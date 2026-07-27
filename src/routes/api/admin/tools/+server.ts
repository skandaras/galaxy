import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/api';
import { CORE_TASKS } from '$lib/server/db/schema';
import {
	builtinDescriptors,
	loadToolSettings,
	toCatalog
} from '$lib/server/engine/tools/registry';
import { mcpDescriptors } from '$lib/server/engine/tools/mcp';

export const GET: RequestHandler = ({ locals }) => {
	requireAdmin(locals);
	const descriptors = [...builtinDescriptors(), ...mcpDescriptors()];
	return json({
		tools: toCatalog(descriptors, loadToolSettings()),
		tasks: CORE_TASKS
	});
};
