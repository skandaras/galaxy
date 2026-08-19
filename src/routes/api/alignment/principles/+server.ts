import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAlignment } from '$lib/server/api';
import { AlignmentError, listPrinciples, listTensions, savePrinciple } from '$lib/server/alignment';

export const GET: RequestHandler = ({ locals }) => {
	const user = requireAlignment(locals);
	return json({ principles: listPrinciples(user.id), tensions: listTensions(user.id) });
};

export const POST: RequestHandler = async ({ locals, request }) => {
	const user = requireAlignment(locals);
	const body = await request.json().catch(() => ({}));
	try {
		const { principle } = savePrinciple(user.id, { ...body, id: undefined }, String(body.note ?? ''));
		return json({ principle }, { status: 201 });
	} catch (err) {
		if (err instanceof AlignmentError) error(400, err.message);
		throw err;
	}
};
