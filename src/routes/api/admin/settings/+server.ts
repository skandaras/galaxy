import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/api';
import {
	DEFAULT_BUDGET,
	DEFAULT_COMPACTION,
	DEFAULT_WEB_SEARCH,
	getSetting,
	setSetting
} from '$lib/server/settings';
import { emitEvent } from '$lib/server/engine/events';

const KNOWN_KEYS = ['websearch', 'compaction', 'budget'] as const;
const DEFAULTS: Record<string, unknown> = {
	websearch: DEFAULT_WEB_SEARCH,
	compaction: DEFAULT_COMPACTION,
	budget: DEFAULT_BUDGET
};

export const GET: RequestHandler = ({ locals }) => {
	requireAdmin(locals);
	return json(
		Object.fromEntries(KNOWN_KEYS.map((k) => [k, getSetting(k, DEFAULTS[k])]))
	);
};

export const PUT: RequestHandler = async ({ locals, request }) => {
	const admin = requireAdmin(locals);
	const body = await request.json().catch(() => ({}));
	const key = body.key as string;
	if (!KNOWN_KEYS.includes(key as (typeof KNOWN_KEYS)[number])) {
		error(400, `Unknown settings key: ${key}`);
	}
	setSetting(key, { ...(DEFAULTS[key] as object), ...(body.value ?? {}) });
	emitEvent({
		userId: admin.id,
		type: 'admin',
		name: `settings.${key}`,
		status: 'ok'
	});
	return json({ ok: true });
};
