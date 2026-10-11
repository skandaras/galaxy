import { redirect } from '@sveltejs/kit';

// Memory was retired for the Profile; an old link or bookmark lands there.
export const load = () => {
	redirect(308, '/profile');
};
