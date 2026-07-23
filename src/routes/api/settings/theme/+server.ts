import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { getSetting, setSetting } from '$lib/server/settings';
import { DEFAULT_THEME, PRESETS, normalizeTheme } from '$lib/theme';

// Per-user theme (scope = user id, key = 'theme').
export const GET: RequestHandler = ({ locals }) => {
	const user = requireUser(locals);
	return json({
		theme: normalizeTheme(getSetting('theme', DEFAULT_THEME, user.id)),
		presets: PRESETS
	});
};

export const PUT: RequestHandler = async ({ locals, request }) => {
	const user = requireUser(locals);
	const body = await request.json().catch(() => ({}));
	const theme = normalizeTheme(body.theme);
	setSetting('theme', theme, user.id);
	return json({ theme });
};
