import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { profileWrite, requireUser } from '$lib/server/api';
import { deleteEntity, updateEntity } from '$lib/server/profile';

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	const user = requireUser(locals);
	const body = await request.json().catch(() => ({}));
	const entity = profileWrite(() =>
		updateEntity(user.id, params.id, {
			name: typeof body.name === 'string' ? body.name : undefined,
			aka: Array.isArray(body.aka) ? body.aka : undefined,
			relation: typeof body.relation === 'string' ? body.relation : undefined,
			named: typeof body.named === 'boolean' ? body.named : undefined
		})
	);
	return json({ entity });
};

/** Takes their card with them; claims about them filed elsewhere stay, about no one. */
export const DELETE: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	if (!deleteEntity(user.id, params.id)) error(404, 'Not found');
	return json({ ok: true });
};
