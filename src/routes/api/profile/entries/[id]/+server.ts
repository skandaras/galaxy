import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { profileWrite, requireUser } from '$lib/server/api';
import {
	correctEntry,
	deleteEntry,
	setPinned,
	setSensitivity,
	type Sensitivity
} from '$lib/server/profile';

const SENSITIVITIES: Sensitivity[] = ['normal', 'personal', 'private'];

/**
 * One change at a time: a reworded claim is a correction, so the old wording
 * stays in the history; a pin or a sensitivity is a setting on the entry.
 */
export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	const user = requireUser(locals);
	const body = await request.json().catch(() => ({}));
	if (typeof body.claim === 'string') {
		const entry = profileWrite(() =>
			correctEntry(user.id, params.id, { claim: body.claim }, { source: 'stated' })
		);
		return json({ entry });
	}
	if (typeof body.pinned === 'boolean') {
		return json({ entry: profileWrite(() => setPinned(user.id, params.id, body.pinned)) });
	}
	if (SENSITIVITIES.includes(body.sensitivity)) {
		return json({ entry: profileWrite(() => setSensitivity(user.id, params.id, body.sensitivity)) });
	}
	error(400, 'Send a claim, pinned or a sensitivity');
};

/** Forgets the entry with every version of it. */
export const DELETE: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	const removed = deleteEntry(user.id, params.id);
	if (!removed) error(404, 'Entry not found');
	return json({ removed });
};
