import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/api';
import { emitEvent } from '$lib/server/engine/events';
import { shelfClient } from '$lib/server/ivory/github';
import { setupShelf } from '$lib/server/ivory/setup';
import { shelfErrorMessage } from '$lib/server/ivory/view';

// Seed the Shelf's missing templates and create its labels. Idempotent.
export const POST: RequestHandler = async ({ locals }) => {
	const admin = requireAdmin(locals);
	const client = shelfClient();
	if (!client) error(409, 'No GitHub token is configured. Add one in Admin → Settings → GitHub.');
	try {
		const result = await setupShelf(client);
		emitEvent({
			userId: admin.id,
			type: 'admin',
			name: 'ivory.setup',
			status: 'ok',
			detail: { repo: client.repo, ...result }
		});
		return json({ repo: client.repo, ...result });
	} catch (err) {
		const message = shelfErrorMessage(err, client.repo);
		emitEvent({ userId: admin.id, type: 'admin', name: 'ivory.setup', status: 'error', detail: { error: message } });
		error(502, message);
	}
};
