import { error, json } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/api';
import { db } from '$lib/server/db';
import { users } from '$lib/server/db/schema';
import { emitEvent } from '$lib/server/engine/events';

/**
 * Accounts and what they may do.
 *
 * `isAdmin` is deliberately read-only here: it is re-derived from Authelia
 * group membership on every request (hooks.server.ts), so writing it would be
 * overwritten on the user's next page load. Admin is changed in Authelia.
 */
export const GET: RequestHandler = ({ locals }) => {
	requireAdmin(locals);
	return json(
		db
			.select()
			.from(users)
			.all()
			.map((u) => ({
				id: u.id,
				username: u.username,
				email: u.email,
				displayName: u.displayName,
				isAdmin: u.isAdmin,
				canCode: u.canCode,
				createdAt: u.createdAt.getTime(),
				lastSeenAt: u.lastSeenAt.getTime()
			}))
	);
};

export const PATCH: RequestHandler = async ({ locals, request }) => {
	const admin = requireAdmin(locals);
	const body = await request.json().catch(() => ({}));
	const id = typeof body.id === 'string' ? body.id : '';
	if (!id) error(400, 'id is required');
	if (typeof body.canCode !== 'boolean') error(400, 'canCode must be a boolean');

	const target = db.select().from(users).where(eq(users.id, id)).get();
	if (!target) error(404, 'No such user');

	db.update(users).set({ canCode: body.canCode }).where(eq(users.id, id)).run();
	emitEvent({
		userId: admin.id,
		type: 'admin',
		name: `user.canCode ${target.username} → ${body.canCode}`,
		status: 'ok'
	});
	return json({ ok: true });
};
