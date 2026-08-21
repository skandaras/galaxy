import type { Handle } from '@sveltejs/kit';
import { error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { runMigrations } from '$lib/server/db';
import { seedTaskConfigs, seedSkills, migrateSettings } from '$lib/server/bootstrap';
import { ensureSkillsRepo } from '$lib/server/skills';
import { startScheduler } from '$lib/server/engine/scheduler';
import { isTrustedProxy, parseAuthHeaders, isAdminFromGroups } from '$lib/server/auth';
import { provisionUser } from '$lib/server/users';

runMigrations();
migrateSettings();
seedTaskConfigs();
ensureSkillsRepo();
seedSkills();
startScheduler();

const PUBLIC_PATHS = new Set(['/healthz']);

export const handle: Handle = async ({ event, resolve }) => {
	event.locals.user = null;

	if (PUBLIC_PATHS.has(event.url.pathname)) {
		return resolve(event);
	}

	const authMode = env.AUTH_MODE || 'authelia';
	const adminGroup = env.ADMIN_GROUP || 'galaxy-admins';

	if (authMode === 'dev') {
		const username = env.DEV_USER || 'dev';
		// Dev mode is a local bypass: it already grants admin, so it grants
		// coding too rather than leaving development half-crippled.
		event.locals.user = provisionUser(
			{ username, email: null, displayName: username, groups: [adminGroup] },
			true,
			true
		);
		return resolve(event);
	}

	// Authelia mode: identity headers are only trusted when the request comes
	// straight from the reverse proxy.
	const trusted = (env.TRUSTED_PROXY_IPS || '127.0.0.1,::1').split(',');
	if (!isTrustedProxy(event.getClientAddress(), trusted)) {
		error(403, 'Forbidden: request did not arrive via the trusted proxy');
	}

	const auth = parseAuthHeaders((name) => event.request.headers.get(name));
	if (!auth) {
		error(401, 'Unauthorized: no identity headers present');
	}

	event.locals.user = provisionUser(auth, isAdminFromGroups(auth.groups, adminGroup));
	return resolve(event);
};
