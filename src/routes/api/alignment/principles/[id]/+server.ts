import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAlignment } from '$lib/server/api';
import {
	AlignmentError,
	deletePrinciple,
	getPrinciple,
	principleStats,
	retirePrinciple,
	savePrinciple
} from '$lib/server/alignment';

export const GET: RequestHandler = ({ locals, params }) => {
	const user = requireAlignment(locals);
	const principle = getPrinciple(params.id, user.id);
	if (!principle) error(404, 'Not found');
	return json({ principle, stats: principleStats(user.id, params.id) });
};

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	const user = requireAlignment(locals);
	const body = await request.json().catch(() => ({}));
	try {
		// The note is why this changed, not a field of the principle.
		const { principle, revision } = savePrinciple(
			user.id,
			{ ...body, id: params.id },
			String(body.note ?? '')
		);
		return json({ principle, revision });
	} catch (err) {
		if (err instanceof AlignmentError) error(400, err.message);
		throw err;
	}
};

/**
 * Retire by default; only `?hard=1` actually erases. Retiring is what someone
 * almost always means, and it is the one that keeps the record.
 */
export const DELETE: RequestHandler = ({ locals, params, url }) => {
	const user = requireAlignment(locals);
	if (url.searchParams.get('hard') === '1') {
		if (!deletePrinciple(params.id, user.id)) error(404, 'Not found');
		return json({ deleted: true });
	}
	const principle = retirePrinciple(params.id, user.id);
	if (!principle) error(404, 'Not found');
	return json({ principle });
};
