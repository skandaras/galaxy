import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { profileWrite, requireUser } from '$lib/server/api';
import { addEntry, resolvePath, type Kind, type Sensitivity } from '$lib/server/profile';

/** Something the person wrote on the page themselves: stated, and needing no quote. */
export const POST: RequestHandler = async ({ locals, request }) => {
	const user = requireUser(locals);
	const body = await request.json().catch(() => ({}));
	if (typeof body.path !== 'string' || typeof body.claim !== 'string' || typeof body.kind !== 'string') {
		error(400, 'path, kind and claim are required');
	}
	let expiresAt: Date | null = null;
	if (body.until) {
		expiresAt = new Date(`${String(body.until)}T00:00:00Z`);
		if (Number.isNaN(expiresAt.getTime())) error(400, 'until is a date written YYYY-MM-DD');
	}
	const result = profileWrite(() => {
		const { domain, subdomain } = resolvePath(user.id, body.path);
		return addEntry(
			user.id,
			{
				domain,
				subdomain,
				kind: body.kind as Kind,
				claim: body.claim,
				about: typeof body.about === 'string' && body.about ? body.about : null,
				pinned: body.pinned === true,
				sensitivity:
					typeof body.sensitivity === 'string' ? (body.sensitivity as Sensitivity) : undefined,
				expiresAt
			},
			{ source: 'stated' }
		);
	});
	return json(result);
};
