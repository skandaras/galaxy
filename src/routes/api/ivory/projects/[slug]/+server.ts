import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireCoder } from '$lib/server/api';
import { shelfClient } from '$lib/server/ivory/github';
import { shelfErrorMessage, shelfProjectView } from '$lib/server/ivory/view';

export const GET: RequestHandler = async ({ locals, params }) => {
	requireCoder(locals);
	const client = shelfClient();
	if (!client) error(409, 'No GitHub token is configured. Add one in Admin → Settings → GitHub.');
	let view;
	try {
		view = await shelfProjectView(client, params.slug);
	} catch (err) {
		error(502, shelfErrorMessage(err, client.repo));
	}
	if (!view) error(404, 'No such project on the Shelf');
	return json(view);
};
