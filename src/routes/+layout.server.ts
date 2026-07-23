import type { LayoutServerLoad } from './$types';
import { env } from '$env/dynamic/private';
import { getSetting } from '$lib/server/settings';
import { DEFAULT_THEME, normalizeTheme } from '$lib/theme';

export const load: LayoutServerLoad = ({ locals }) => {
	return {
		user: locals.user,
		galaxyEnv: env.GALAXY_ENV || 'dev',
		theme: locals.user
			? normalizeTheme(getSetting('theme', DEFAULT_THEME, locals.user.id))
			: DEFAULT_THEME
	};
};
