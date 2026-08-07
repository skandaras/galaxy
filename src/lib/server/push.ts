import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import webpush from 'web-push';
import { db } from '$lib/server/db';
import { pushSubscriptions, type notifications } from '$lib/server/db/schema';
import { decryptSecret, encryptSecret } from '$lib/server/crypto';
import { getSetting, setSetting } from '$lib/server/settings';
import { emitEvent } from '$lib/server/engine/events';

type Notification = typeof notifications.$inferSelect;
export type PushSubscription = typeof pushSubscriptions.$inferSelect;

/**
 * Web Push, so a question can reach a phone that is not looking at Galaxy.
 *
 * Everything here is best effort. A push service being slow, unreachable or
 * cross about our payload must never affect the turn that raised the
 * notification — the durable record is the row in `notifications`, and push is
 * only a way of pointing at it.
 */

export interface PushConfig {
	publicKey: string;
	privateKeyEnc: string;
	/** VAPID requires a contact; mailto: or the instance URL. */
	subject: string;
}

const SETTING_KEY = 'push';

export function getPushConfig(): PushConfig | null {
	const cfg = getSetting<Partial<PushConfig>>(SETTING_KEY, {});
	if (!cfg.publicKey || !cfg.privateKeyEnc) return null;
	return {
		publicKey: cfg.publicKey,
		privateKeyEnc: cfg.privateKeyEnc,
		subject: cfg.subject || 'mailto:admin@localhost'
	};
}

/** The key the browser needs to subscribe. Safe to hand out; the pair's public half. */
export function publicKey(): string | null {
	return getPushConfig()?.publicKey ?? null;
}

/**
 * Mint a VAPID key pair and store it. Existing subscriptions are keyed to the
 * old public key and stop working, so they are cleared out at the same time
 * rather than left to fail one by one.
 */
export function generateKeys(subject: string): PushConfig {
	const keys = webpush.generateVAPIDKeys();
	const cfg: PushConfig = {
		publicKey: keys.publicKey,
		privateKeyEnc: encryptSecret(keys.privateKey),
		subject: subject.trim() || 'mailto:admin@localhost'
	};
	setSetting(SETTING_KEY, cfg);
	db.delete(pushSubscriptions).run();
	return cfg;
}

export function setSubject(subject: string): void {
	const cfg = getPushConfig();
	if (!cfg) return;
	setSetting(SETTING_KEY, { ...cfg, subject: subject.trim() || cfg.subject });
}

// --- registrations --------------------------------------------------------

export function listSubscriptions(userId: string): PushSubscription[] {
	return db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId)).all();
}

/**
 * Register a browser. Re-subscribing the same browser yields the same endpoint,
 * so this is an upsert — otherwise a row accumulates on every page load that
 * re-registers.
 */
export function saveSubscription(
	userId: string,
	sub: { endpoint: string; keys: { p256dh: string; auth: string } },
	userAgent = ''
): PushSubscription {
	const row: PushSubscription = {
		id: randomUUID(),
		userId,
		endpoint: sub.endpoint,
		p256dh: sub.keys.p256dh,
		auth: sub.keys.auth,
		userAgent: userAgent.slice(0, 200),
		createdAt: new Date(),
		lastUsedAt: null
	};
	db.insert(pushSubscriptions)
		.values(row)
		.onConflictDoUpdate({
			target: pushSubscriptions.endpoint,
			// An endpoint can be re-registered by a different account on a shared
			// device; whoever registered last owns it.
			set: { userId, p256dh: row.p256dh, auth: row.auth, userAgent: row.userAgent }
		})
		.run();
	return row;
}

export function deleteSubscription(id: string, userId: string): boolean {
	const row = db.select().from(pushSubscriptions).where(eq(pushSubscriptions.id, id)).get();
	if (!row || row.userId !== userId) return false;
	db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, id)).run();
	return true;
}

// --- sending --------------------------------------------------------------

/**
 * Push a notification to every device its owner has registered.
 *
 * Only urgent notifications are pushed. Everything else waits for the bell —
 * a workspace that buzzes a phone for each card someone ticks off gets its
 * permission revoked within a day.
 */
export async function sendPush(n: Notification): Promise<void> {
	if (!n.urgent) return;
	const cfg = getPushConfig();
	if (!cfg) return;

	const subs = listSubscriptions(n.userId);
	if (!subs.length) return;

	const payload = JSON.stringify({
		id: n.id,
		title: n.title,
		body: n.body,
		link: n.link,
		kind: n.kind
	});
	const options = {
		vapidDetails: {
			subject: cfg.subject,
			publicKey: cfg.publicKey,
			privateKey: decryptSecret(cfg.privateKeyEnc)
		},
		TTL: 600
	};

	let delivered = 0;
	let dropped = 0;
	for (const sub of subs) {
		try {
			await webpush.sendNotification(
				{ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
				payload,
				options
			);
			db.update(pushSubscriptions)
				.set({ lastUsedAt: new Date() })
				.where(eq(pushSubscriptions.id, sub.id))
				.run();
			delivered++;
		} catch (err) {
			// 404/410 mean the browser threw the registration away — uninstalled,
			// permission revoked, profile wiped. Retrying that forever is pointless.
			const status = (err as { statusCode?: number }).statusCode;
			if (status === 404 || status === 410) {
				db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, sub.id)).run();
				dropped++;
			} else {
				emitEvent({
					userId: n.userId,
					type: 'job',
					name: 'push.failed',
					status: 'error',
					detail: { status: status ?? null, error: String(err).slice(0, 200) }
				});
			}
		}
	}
	if (delivered || dropped) {
		emitEvent({
			userId: n.userId,
			type: 'job',
			name: 'push.sent',
			status: 'ok',
			detail: { delivered, dropped, kind: n.kind }
		});
	}
}
