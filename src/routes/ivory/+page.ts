import { redirect } from '@sveltejs/kit';

// Ivory Tower is switched off and its code archived; an old link or bookmark
// lands on chat rather than a 404.
export const load = () => {
	redirect(308, '/chat');
};
