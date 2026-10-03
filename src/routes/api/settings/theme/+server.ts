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
	const presets = customPresets(user.id);

	// `saveTo` writes back into a theme you already have, `saveAs` makes a new
	// one, and they are separate so that neither can do the other's job by
	// accident: saveAs used to overwrite any theme that shared the name, with
	// nothing said, and would also make a "Galaxy" of yours beside the built-in
	// Galaxy, leaving two chips with one name.
	let collection: Record<string, Theme> | null = null;
	if (typeof body.saveTo === 'string') {
		if (!(body.saveTo in presets)) error(404, `There is no saved theme called "${body.saveTo}".`);
		collection = { ...presets, [body.saveTo]: theme };
	} else if (typeof body.saveAs === 'string' && body.saveAs.trim()) {
		const name = body.saveAs.trim().slice(0, 40);
		const taken = [...Object.keys(presets), ...Object.keys(PRESETS)];
		if (taken.some((n) => n.toLowerCase() === name.toLowerCase())) {
			error(409, `There is already a theme called "${name}".`);
		}
		if (Object.keys(presets).length >= MAX_CUSTOM) {
			error(400, `Too many saved themes (max ${MAX_CUSTOM})`);
		}
		collection = { ...presets, [name]: theme };
	}

	// Checked before anything is written, so a refused name leaves the active
	// theme as it was too.
	setSetting('theme', theme, user.id);
	if (collection) setSetting(CUSTOM_KEY, collection, user.id);
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
