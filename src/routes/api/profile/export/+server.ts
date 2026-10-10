import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { exportMarkdown } from '$lib/server/profile';

export const GET: RequestHandler = ({ locals }) => {
	const user = requireUser(locals);
	return new Response(exportMarkdown(user.id), {
		headers: {
			'content-type': 'text/markdown; charset=utf-8',
			'content-disposition': 'attachment; filename="profile.md"'
		}
	});
};
