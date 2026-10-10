import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { profileWrite, requireUser } from '$lib/server/api';
import { createEntity, ENTITY_KINDS, type EntityKind } from '$lib/server/profile';

export const POST: RequestHandler = async ({ locals, request }) => {
	const user = requireUser(locals);
	const body = await request.json().catch(() => ({}));
	if (!(ENTITY_KINDS as readonly string[]).includes(body.kind) || typeof body.name !== 'string') {
		error(400, `kind (${ENTITY_KINDS.join(', ')}) and name are required`);
	}
	const entity = profileWrite(() =>
		createEntity(user.id, {
			kind: body.kind as EntityKind,
			name: body.name,
			relation: typeof body.relation === 'string' ? body.relation : '',
			aka: Array.isArray(body.aka) ? body.aka : [],
			named: typeof body.named === 'boolean' ? body.named : undefined
		})
	);
	return json({ entity });
};
