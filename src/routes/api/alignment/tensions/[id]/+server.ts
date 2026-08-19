import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAlignment } from '$lib/server/api';
import { deleteTension } from '$lib/server/alignment';

export const DELETE: RequestHandler = ({ locals, params }) => {
	const user = requireAlignment(locals);
	if (!deleteTension(params.id, user.id)) error(404, 'Not found');
	return json({ deleted: true });
};
