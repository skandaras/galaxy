import type { LayoutServerLoad } from './$types';
import { env } from '$env/dynamic/private';
import {
	ALIGNMENT_ENABLED_KEY,
	DEFAULT_ALIGNMENT,
	getSetting,
	type AlignmentSettings
} from '$lib/server/settings';
import { DEFAULT_THEME, normalizeTheme } from '$lib/theme';

export const load: LayoutServerLoad = ({ locals }) => {
	return {
		user: locals.user,
		galaxyEnv: env.GALAXY_ENV || 'dev',
		theme: locals.user
			? normalizeTheme(getSetting('theme', DEFAULT_THEME, locals.user.id))
			: DEFAULT_THEME,
		// Off unless this person switched it on for themselves. The API refuses it
		// either way (requireAlignment); this only decides whether to offer it.
		alignmentEnabled:
			!!locals.user &&
			getSetting<AlignmentSettings>('alignment', DEFAULT_ALIGNMENT).enabled &&
			getSetting<boolean>(ALIGNMENT_ENABLED_KEY, false, locals.user.id)
	};
};
