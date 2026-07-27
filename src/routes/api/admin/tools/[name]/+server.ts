import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/api';
import {
	builtinDescriptors,
	loadToolSettings,
	normaliseTaskScope,
	resetToolSetting,
	saveToolSetting,
	toCatalog,
	type ToolSetting
} from '$lib/server/engine/tools/registry';
import { mcpDescriptors } from '$lib/server/engine/tools/mcp';

function known(name: string) {
	return [...builtinDescriptors(), ...mcpDescriptors()].find((d) => d.name === name);
}

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	requireAdmin(locals);
	const descriptor = known(params.name);
	if (!descriptor) error(404, 'No such tool');

	const body = await request.json().catch(() => ({}));
	const patch: Partial<ToolSetting> = {};
	if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
	if (typeof body.descriptionOverride === 'string') {
		patch.descriptionOverride = body.descriptionOverride.trim();
	}
	if (body.tasks === null || Array.isArray(body.tasks)) {
		// Scoping only narrows, so store the intersection with the tool's own
		// tasks — and nothing at all when that covers all of them.
		const tasks = Array.isArray(body.tasks)
			? body.tasks.filter((t: unknown): t is string => typeof t === 'string')
			: null;
		patch.tasks = normaliseTaskScope(descriptor.tasks, tasks);
	}
	if (!Object.keys(patch).length) error(400, 'Nothing to update');

	saveToolSetting(params.name, patch);
	const entry = toCatalog([descriptor], loadToolSettings())[0];
	return json(entry);
};

/** Drop the override row and go back to the tool's coded defaults. */
export const DELETE: RequestHandler = ({ locals, params }) => {
	requireAdmin(locals);
	if (!known(params.name)) error(404, 'No such tool');
	resetToolSetting(params.name);
	return json({ ok: true });
};
