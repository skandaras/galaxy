import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAlignment } from '$lib/server/api';
import {
	AlignmentError,
	assessmentsForEntry,
	deleteEntry,
	entryHash,
	getEntry,
	saveEntry
} from '$lib/server/alignment';

export const GET: RequestHandler = ({ locals, params }) => {
	const user = requireAlignment(locals);
	const entry = getEntry(params.id, user.id);
	if (!entry) error(404, 'Not found');
	const assessments = assessmentsForEntry(params.id, user.id);
	const hash = entryHash(entry.body);
	return json({
		entry,
		// Every assessment this entry has had, newest first — re-assessing after a
		// constitution edit adds to this rather than replacing what came before.
		assessments: assessments.map((a) => ({ ...a, stale: a.entryHash !== hash }))
	});
};

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	const user = requireAlignment(locals);
	const body = await request.json().catch(() => ({}));
	try {
		return json({ entry: saveEntry(user.id, { ...body, id: params.id }) });
	} catch (err) {
		if (err instanceof AlignmentError) error(400, err.message);
		throw err;
	}
};

export const DELETE: RequestHandler = ({ locals, params }) => {
	const user = requireAlignment(locals);
	if (!deleteEntry(params.id, user.id)) error(404, 'Not found');
	return json({ deleted: true });
};
