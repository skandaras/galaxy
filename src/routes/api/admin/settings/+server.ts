import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/api';
import {
	DEFAULT_COMPACTION,
	DEFAULT_WEB_SEARCH,
	getSetting,
	setSetting
} from '$lib/server/settings';

const KNOWN_KEYS = ['websearch', 'compaction'] as const;
const DEFAULTS: Record<string, unknown> = {
	websearch: DEFAULT_WEB_SEARCH,
	compaction: DEFAULT_COMPACTION
};

export const GET: RequestHandler = ({ locals }) => {
	requireAdmin(locals);
	return json(
		Object.fromEntries(KNOWN_KEYS.map((k) => [k, getSetting(k, DEFAULTS[k])]))
	);
};

export const PUT: RequestHandler = async ({ locals, request }) => {
	requireAdmin(locals);
	const body = await request.json().catch(() => ({}));
	const key = body.key as string;
	if (!KNOWN_KEYS.includes(key as (typeof KNOWN_KEYS)[number])) {
		error(400, `Unknown settings key: ${key}`);
	}
	setSetting(key, { ...(DEFAULTS[key] as object), ...(body.value ?? {}) });
	return json({ ok: true });
};
