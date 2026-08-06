import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { users } from '$lib/server/db/schema';
import type { AuthHeaders, SessionUser } from '$lib/server/auth';

// Throttle last-seen writes so every request isn't a DB write.
const LAST_SEEN_INTERVAL_MS = 5 * 60 * 1000;
const lastSeenCache = new Map<string, number>();

/**
 * Find-or-create the user for an authenticated identity.
 *
 * `grantCode` is for dev mode, which already bypasses Authelia and grants
 * admin; withholding coding there would only break local development. In
 * Authelia mode it is false and the stored per-user grant decides.
 */
export function provisionUser(
	auth: AuthHeaders,
	isAdmin: boolean,
	grantCode = false
): SessionUser {
	const now = Date.now();
	const existing = db.select().from(users).where(eq(users.username, auth.username)).get();

	if (!existing) {
		const row = {
			id: randomUUID(),
			username: auth.username,
			email: auth.email,
			displayName: auth.displayName,
			isAdmin,
			// Off for anyone new: coding pushes with a shared GitHub token, so it
			// is granted deliberately in Admin → Users rather than on sign-up.
			canCode: grantCode,
			createdAt: new Date(now),
			lastSeenAt: new Date(now)
		};
		db.insert(users).values(row).run();
		lastSeenCache.set(auth.username, now);
		return toSessionUser(row);
	}

	const cachedSeen = lastSeenCache.get(auth.username) ?? 0;
	const adminChanged = existing.isAdmin !== isAdmin;
	if (adminChanged || now - cachedSeen > LAST_SEEN_INTERVAL_MS) {
		db.update(users)
			.set({ lastSeenAt: new Date(now), isAdmin, email: auth.email ?? existing.email })
			.where(eq(users.id, existing.id))
			.run();
		lastSeenCache.set(auth.username, now);
	}

	return toSessionUser({ ...existing, isAdmin, canCode: grantCode || existing.canCode });
}

function toSessionUser(row: {
	id: string;
	username: string;
	email: string | null;
	displayName: string | null;
	isAdmin: boolean;
	canCode?: boolean;
}): SessionUser {
	return {
		id: row.id,
		username: row.username,
		email: row.email,
		displayName: row.displayName,
		isAdmin: row.isAdmin,
		canCode: row.canCode ?? false
	};
}
