import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { profileWrite, requireUser } from '$lib/server/api';
import { addSubdomain, DOMAINS, isSensitivity, type Domain } from '$lib/server/profile';

export const POST: RequestHandler = async ({ locals, request }) => {
	const user = requireUser(locals);
	const body = await request.json().catch(() => ({}));
	if (!(DOMAINS as readonly string[]).includes(body.domain) || typeof body.name !== 'string') {
		error(400, 'domain and name are required');
	}
	const sensitivity = isSensitivity(body.sensitivity) ? body.sensitivity : 'normal';
	const name = profileWrite(() => addSubdomain(user.id, body.domain as Domain, body.name, sensitivity));
	return json({ name });
};
