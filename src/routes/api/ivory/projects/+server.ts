import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireCoder } from '$lib/server/api';
import { shelfClient } from '$lib/server/ivory/github';
import { shelfErrorMessage, shelfIndex } from '$lib/server/ivory/view';
import { ivorySettings } from '$lib/server/settings';

// The Shelf index: projects grouped by discipline, with open-task counts from the board.
export const GET: RequestHandler = async ({ locals }) => {
	requireCoder(locals);
	const client = shelfClient();
	if (!client) return json({ configured: false, repo: ivorySettings().shelfRepo });
	try {
		return json({ configured: true, ...(await shelfIndex(client)) });
	} catch (err) {
		error(502, shelfErrorMessage(err, client.repo));
	}
};
