import { json } from '@sveltejs/kit';
import { configuredAssetLinks } from '$lib/server/assetlinks';

/**
 * `/.well-known/assetlinks.json` — how an Android build claims this origin.
 *
 * Two things here break the rules deliberately.
 *
 * It does not guard. Every other route calls requireUser or stricter, and one
 * that doesn't is normally a bug; this one is fetched by a browser that has no
 * session and never will, so a guard here would mean the address bar never
 * goes away. It reads nothing but two env vars, so there is nothing behind it
 * to leak. The path is also listed in PUBLIC_PATHS in hooks.server.ts, or the
 * auth hook rejects it before this handler is reached.
 *
 * The directory is [x+2e]well-known rather than .well-known because SvelteKit
 * drops dot-prefixed directories from the route manifest — and so does ESLint,
 * so the route would silently go unlinted too.
 *
 * Authelia sits in front of all of this and will send the fetch to a login
 * page unless the proxy is told otherwise; docs/INSTALL.md carries the bypass.
 */
export const GET = () => {
	const links = configuredAssetLinks();
	if (!links) return json({ error: 'No Android app is configured for this instance' }, { status: 404 });
	return json(links);
};
