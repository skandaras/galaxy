import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { listSubscriptions, publicKey, saveSubscription } from '$lib/server/push';

/** The browser needs the VAPID public key before it can subscribe. */
export const GET: RequestHandler = ({ locals }) => {
	const user = requireUser(locals);
	return json({
		publicKey: publicKey(),
		devices: listSubscriptions(user.id).map((s) => ({
			id: s.id,
			userAgent: s.userAgent,
			createdAt: s.createdAt.getTime(),
			lastUsedAt: s.lastUsedAt?.getTime() ?? null
		}))
	});
};

export const POST: RequestHandler = async ({ locals, request }) => {
	const user = requireUser(locals);
	if (!publicKey()) error(409, 'Push is not set up yet — an admin generates the keys in Admin → Settings');

	const body = await request.json().catch(() => ({}));
	const endpoint = typeof body.endpoint === 'string' ? body.endpoint : '';
	const p256dh = body.keys?.p256dh;
	const auth = body.keys?.auth;
	if (!endpoint || typeof p256dh !== 'string' || typeof auth !== 'string') {
		error(400, 'Expected a PushSubscription with endpoint and keys');
	}

	const sub = saveSubscription(
		user.id,
		{ endpoint, keys: { p256dh, auth } },
		request.headers.get('user-agent') ?? ''
	);
	return json({ id: sub.id }, { status: 201 });
};
