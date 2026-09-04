import type { Handle } from '@sveltejs/kit';
import { error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { runMigrations } from '$lib/server/db';
import {
	seedTaskConfigs,
	seedSkills,
	migrateSettings,
	migrateTaskPrompts,
	migrateChats
} from '$lib/server/bootstrap';
import { ensureSkillsRepo } from '$lib/server/skills';
import { typstAvailable } from '$lib/server/pdf';
import { startScheduler } from '$lib/server/engine/scheduler';
import { isTrustedProxy, parseAuthHeaders, isAdminFromGroups } from '$lib/server/auth';
import { provisionUser } from '$lib/server/users';

runMigrations();
migrateSettings();
migrateChats();
seedTaskConfigs();
// After the seed, so a task that has just been created is already current, and
// before anything can run: a stored prompt that is still the shipped default is
// one nobody has claimed, so an improvement to it should actually arrive.
migrateTaskPrompts();
ensureSkillsRepo();
seedSkills();
startScheduler();
// Settle "can this instance make PDFs?" now, so assembling a toolset — which is
// synchronous — can just read the answer.
void typstAvailable();

// Digital Asset Links has to answer a browser that has no session — it is what
// tells Android the TWA owns this origin, and it is fetched signed out.
const PUBLIC_PATHS = new Set(['/healthz', '/.well-known/assetlinks.json']);

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
