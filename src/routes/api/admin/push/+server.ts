import { json } from '@sveltejs/kit';
import { sql } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/api';
import { db } from '$lib/server/db';
import { pushSubscriptions } from '$lib/server/db/schema';
import { generateKeys, getPushConfig, setSubject } from '$lib/server/push';
import { emitEvent } from '$lib/server/engine/events';

const deviceCount = () =>
	db.select({ n: sql<number>`count(*)` }).from(pushSubscriptions).get()?.n ?? 0;

export const GET: RequestHandler = ({ locals }) => {
	requireAdmin(locals);
	const cfg = getPushConfig();
	// The private half never leaves the server.
	return json({
		configured: !!cfg,
		publicKey: cfg?.publicKey ?? null,
		subject: cfg?.subject ?? '',
		devices: deviceCount()
	});
};

export const POST: RequestHandler = async ({ locals, request }) => {
	const admin = requireAdmin(locals);
	const body = await request.json().catch(() => ({}));
	const subject = typeof body.subject === 'string' ? body.subject : '';

	if (body.action === 'generate') {
		// Regenerating invalidates every existing registration, so say so plainly
		// rather than leaving people wondering why their phone went quiet.
		const had = deviceCount();
		const cfg = generateKeys(subject);
		emitEvent({
			userId: admin.id,
			type: 'admin',
			name: 'push.keys.generated',
			status: 'ok',
			detail: { clearedDevices: had }
		});
		return json({ publicKey: cfg.publicKey, clearedDevices: had });
	}

	setSubject(subject);
	return json({ ok: true });
};
