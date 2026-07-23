import type { LayoutServerLoad } from './$types';
import { env } from '$env/dynamic/private';

export const load: LayoutServerLoad = ({ locals }) => {
	return {
		user: locals.user,
		galaxyEnv: env.GALAXY_ENV || 'dev'
	};
};
