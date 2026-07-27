import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/api';
import {
	builtinDescriptors,
	loadToolSettings,
	toCatalog,
	TOOL_TASKS
} from '$lib/server/engine/tools/registry';
import { mcpDescriptors } from '$lib/server/engine/tools/mcp';

export const GET: RequestHandler = ({ locals }) => {
	requireAdmin(locals);
	const descriptors = [...builtinDescriptors(), ...mcpDescriptors()];
	return json({
		tools: toCatalog(descriptors, loadToolSettings()),
		// Only the tasks that actually gate tools — not every CORE_TASK.
		tasks: TOOL_TASKS
	});
};
