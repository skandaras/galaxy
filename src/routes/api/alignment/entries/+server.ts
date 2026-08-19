import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAlignment } from '$lib/server/api';
import {
	AlignmentError,
	entryHash,
	latestAssessments,
	listEntries,
	saveEntry
} from '$lib/server/alignment';

/**
 * Entries with their newest assessment attached, and a `stale` flag where the
 * entry has been edited since it was read. Stale rather than hidden: the old
 * reading is still what the agent said, it just no longer describes this text.
 */
export const GET: RequestHandler = ({ locals }) => {
	const user = requireAlignment(locals);
	const entries = listEntries(user.id);
	const byEntry = new Map(latestAssessments(user.id, 200).map((a) => [a.entryId, a]));
	return json({
		entries: entries.map((e) => {
			const assessment = byEntry.get(e.id) ?? null;
			return {
				...e,
				assessment,
				stale: !!assessment && assessment.entryHash !== entryHash(e.body)
			};
		})
	});
};

export const POST: RequestHandler = async ({ locals, request }) => {
	const user = requireAlignment(locals);
	const body = await request.json().catch(() => ({}));
	try {
		return json({ entry: saveEntry(user.id, { ...body, id: undefined }) }, { status: 201 });
	} catch (err) {
		if (err instanceof AlignmentError) error(400, err.message);
		throw err;
	}
};
