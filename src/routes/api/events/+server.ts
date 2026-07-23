import { json } from '@sveltejs/kit';
import { and, desc, eq, type SQL } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { requireUser } from '$lib/server/api';
import { db } from '$lib/server/db';
import { events } from '$lib/server/db/schema';

// Persisted Observatory backlog (the live tail is /api/events/stream).
// Admins see all events; other users only their own.
export const GET: RequestHandler = ({ locals, url }) => {
	const user = requireUser(locals);
	const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 100, 1), 500);

	const conditions: SQL[] = [];
	if (!user.isAdmin) conditions.push(eq(events.userId, user.id));
	const type = url.searchParams.get('type');
	if (type) conditions.push(eq(events.type, type));
	const status = url.searchParams.get('status');
	if (status === 'ok' || status === 'error' || status === 'running') {
		conditions.push(eq(events.status, status));
	}
	const chatId = url.searchParams.get('chatId');
	if (chatId) conditions.push(eq(events.chatId, chatId));

	const rows = db
		.select()
		.from(events)
		.where(conditions.length ? and(...conditions) : undefined)
		.orderBy(desc(events.ts))
		.limit(limit)
		.all();
	return json(rows.map((r) => ({ ...r, ts: r.ts.getTime() })));
};
