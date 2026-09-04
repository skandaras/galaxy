import { env } from '$env/dynamic/private';

/**
 * Digital Asset Links: the statement that lets an Android app claim this
 * origin as its own. A Trusted Web Activity whose signing key is not listed
 * here still runs — it just draws a browser address bar across the top, which
 * is the whole visible difference between "an app" and "a browser someone put
 * a launcher icon on".
 *
 * It cannot ship in the repo. The fingerprint belongs to whoever built the
 * APK, and every self-hosted deployment signs its own, so it arrives as
 * deployment config the same way ORIGIN and ADMIN_GROUP do.
 */

export interface AssetLinkStatement {
	relation: string[];
	target: {
		namespace: 'android_app';
		package_name: string;
		sha256_cert_fingerprints: string[];
	};
}

/**
 * Build the statement list. Returns null when either half is missing — an
 * instance nobody has built an APK for should say it has no statement rather
 * than serve an empty one, which reads as "no app may claim this origin" and
 * is a different (and cacheable) answer.
 *
 * Several fingerprints are normal, not an edge case: a debug key and a release
 * key differ, so the app you are testing and the app you will install need
 * both listed at once.
 */
export function assetLinks(packageId: string, fingerprints: string): AssetLinkStatement[] | null {
	const pkg = packageId.trim();
	const certs = fingerprints
		.split(',')
		.map((f) => f.trim().toUpperCase())
		.filter((f) => f.length > 0);
	if (!pkg || certs.length === 0) return null;

	return [
		{
			relation: ['delegate_permission/common.handle_all_urls'],
			target: {
				namespace: 'android_app',
				package_name: pkg,
				sha256_cert_fingerprints: certs
			}
		}
	];
}

/** The statement this instance is configured to serve, if any. */
export function configuredAssetLinks(): AssetLinkStatement[] | null {
	return assetLinks(env.TWA_PACKAGE_ID || '', env.TWA_FINGERPRINTS || '');
}
