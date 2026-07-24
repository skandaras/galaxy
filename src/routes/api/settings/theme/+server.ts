import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { getSetting, setSetting } from '$lib/server/settings';
import { DEFAULT_THEME, PRESETS, normalizeTheme, type Theme } from '$lib/theme';

// Per-user: the active theme (key 'theme') and a named collection of custom
// presets (key 'themePresets'), both scoped to the user id.
const CUSTOM_KEY = 'themePresets';
const MAX_CUSTOM = 24;

function customPresets(userId: string): Record<string, Theme> {
	const raw = getSetting<Record<string, unknown>>(CUSTOM_KEY, {}, userId);
	const out: Record<string, Theme> = {};
	for (const [name, t] of Object.entries(raw)) out[name] = normalizeTheme(t);
	return out;
}

export const GET: RequestHandler = ({ locals }) => {
	const user = requireUser(locals);
	return json({
		theme: normalizeTheme(getSetting('theme', DEFAULT_THEME, user.id)),
		presets: PRESETS,
		custom: customPresets(user.id)
	});
};

export const PUT: RequestHandler = async ({ locals, request }) => {
	const user = requireUser(locals);
	const body = await request.json().catch(() => ({}));
	const theme = normalizeTheme(body.theme);
	setSetting('theme', theme, user.id);

	// Optionally save this theme as a named custom preset in the same call.
	if (typeof body.saveAs === 'string' && body.saveAs.trim()) {
		const name = body.saveAs.trim().slice(0, 40);
		const presets = customPresets(user.id);
		if (!(name in presets) && Object.keys(presets).length >= MAX_CUSTOM) {
			error(400, `Too many saved themes (max ${MAX_CUSTOM})`);
		}
		presets[name] = theme;
		setSetting(CUSTOM_KEY, presets, user.id);
	}
	return json({ theme, custom: customPresets(user.id) });
};

export const DELETE: RequestHandler = ({ locals, url }) => {
	const user = requireUser(locals);
	const name = url.searchParams.get('name');
	if (!name) error(400, 'name is required');
	const presets = customPresets(user.id);
	delete presets[name];
	setSetting(CUSTOM_KEY, presets, user.id);
	return json({ custom: presets });
};
