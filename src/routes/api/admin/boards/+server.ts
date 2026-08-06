import { json } from '@sveltejs/kit';
import { eq, sql } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/api';
import { db } from '$lib/server/db';
import { boardMembers, boards, cards, users } from '$lib/server/db/schema';

/**
 * Every board on the instance, for the admin overview.
 *
 * Deliberately names and counts only — an admin runs the platform, which is not
 * the same as being on everyone's boards, and card titles are the private part.
 */
export const GET: RequestHandler = ({ locals }) => {
	requireAdmin(locals);
	const rows = db
		.select({
			id: boards.id,
			name: boards.name,
			ownerId: boards.ownerId,
			owner: users.username,
			archivedAt: boards.archivedAt,
			createdAt: boards.createdAt
		})
		.from(boards)
		.leftJoin(users, eq(users.id, boards.ownerId))
		.all();

	// Both tables key on board_id, so one grouped count serves either.
	const counts = (table: typeof cards | typeof boardMembers) =>
		new Map(
			db
				.select({ boardId: sql<string>`board_id`, n: sql<number>`count(*)` })
				.from(table)
				.groupBy(sql`board_id`)
				.all()
				.map((r) => [r.boardId, r.n])
		);

	const cardCounts = counts(cards);
	const memberCounts = counts(boardMembers);

	return json(
		rows.map((b) => ({
			...b,
			owner: b.owner ?? b.ownerId,
			archivedAt: b.archivedAt?.getTime() ?? null,
			createdAt: b.createdAt.getTime(),
			cards: cardCounts.get(b.id) ?? 0,
			members: memberCounts.get(b.id) ?? 0
		}))
	);
};
