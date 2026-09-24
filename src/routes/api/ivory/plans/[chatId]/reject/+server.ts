import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireCoder } from '$lib/server/api';
import { PlanError, rejectPlan } from '$lib/server/ivory/plan';

// Reject a plan. Nothing reaches GitHub.
export const POST: RequestHandler = ({ locals, params }) => {
	const user = requireCoder(locals);
	try {
		rejectPlan({ chatId: params.chatId, userId: user.id });
		return json({ ok: true });
	} catch (err) {
		if (err instanceof PlanError) error(err.status, err.message);
		throw err;
	}
};
