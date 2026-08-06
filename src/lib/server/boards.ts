import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, asc, desc, eq, inArray, isNull, isNotNull, sql } from 'drizzle-orm';
import { db, dataDir } from '$lib/server/db';
import {
	boardLanes,
	boardMembers,
	boardStatuses,
	boards,
	cardAttachments,
	cardLog,
	cards,
	users,
	type BoardRole,
	type CardPriority
} from '$lib/server/db/schema';

export type Board = typeof boards.$inferSelect;
export type BoardLane = typeof boardLanes.$inferSelect;
export type BoardStatus = typeof boardStatuses.$inferSelect;
export type Card = typeof cards.$inferSelect;
export type CardLogEntry = typeof cardLog.$inferSelect;
export type CardAttachment = typeof cardAttachments.$inferSelect;

/** Lanes are columns on a screen, so the ceiling is what fits, not what scales. */
export const MAX_LANES = 5;

const cardUploadsDir = (cardId: string) => join(dataDir, 'uploads', 'cards', cardId);

// --- access ---------------------------------------------------------------

/**
 * This user's role on a board, or null if they cannot see it at all.
 *
 * Membership is the whole access model: a board's owner gets a member row when
 * the board is created, so there is no "owner or member" branch anywhere and
 * no way to be an owner without being visible in the members list.
 */
export function boardRole(boardId: string, userId: string): BoardRole | null {
	const row = db
		.select({ role: boardMembers.role })
		.from(boardMembers)
		.where(and(eq(boardMembers.boardId, boardId), eq(boardMembers.userId, userId)))
		.get();
	return row?.role ?? null;
}

/** Board ids this user may read. The predicate every board query starts from. */
export function boardIdsFor(userId: string): string[] {
	return db
		.select({ id: boardMembers.boardId })
		.from(boardMembers)
		.where(eq(boardMembers.userId, userId))
		.all()
		.map((r) => r.id);
}

export function getBoard(boardId: string, userId: string): Board | null {
	if (!boardRole(boardId, userId)) return null;
	return db.select().from(boards).where(eq(boards.id, boardId)).get() ?? null;
}

export function listBoards(userId: string, includeArchived = false): (Board & { role: BoardRole })[] {
	const rows = db
		.select({ board: boards, role: boardMembers.role })
		.from(boardMembers)
		.innerJoin(boards, eq(boards.id, boardMembers.boardId))
		.where(eq(boardMembers.userId, userId))
		.orderBy(asc(boards.createdAt))
		.all();
	return rows
		.filter((r) => includeArchived || !r.board.archivedAt)
		.map((r) => ({ ...r.board, role: r.role }));
}

// --- boards ---------------------------------------------------------------

/**
 * Default lanes and statuses for a new board.
 *
 * Lanes deliberately do not repeat the status names: status carries the
 * workflow, so lanes are free to group by when you intend to get to something.
 */
const DEFAULT_LANES = ['Now', 'Next', 'Someday'];
const DEFAULT_STATUSES: { name: string; colour: string; isDone: boolean }[] = [
	{ name: 'To do', colour: '#8a8f98', isDone: false },
	{ name: 'In progress', colour: '#f2c94c', isDone: false },
	{ name: 'Blocked', colour: '#eb5757', isDone: false },
	{ name: 'Done', colour: '#27ae60', isDone: true }
];

export function createBoard(opts: {
	ownerId: string;
	name: string;
	description?: string;
}): Board {
	const now = new Date();
	const board: Board = {
		id: randomUUID(),
		ownerId: opts.ownerId,
		name: opts.name.trim() || 'Untitled board',
		description: opts.description?.trim() ?? '',
		archivedAt: null,
		createdAt: now,
		updatedAt: now
	};
	db.transaction((tx) => {
		tx.insert(boards).values(board).run();
		tx.insert(boardMembers)
			.values({ boardId: board.id, userId: opts.ownerId, role: 'owner', createdAt: now })
			.run();
		tx.insert(boardLanes)
			.values(
				DEFAULT_LANES.map((name, i) => ({ id: randomUUID(), boardId: board.id, name, position: i }))
			)
			.run();
		tx.insert(boardStatuses)
			.values(
				DEFAULT_STATUSES.map((s, i) => ({
					id: randomUUID(),
					boardId: board.id,
					name: s.name,
					colour: s.colour,
					position: i,
					isDone: s.isDone
				}))
			)
			.run();
	});
	return board;
}

export function updateBoard(
	boardId: string,
	userId: string,
	patch: { name?: string; description?: string; archived?: boolean }
): Board | null {
	// Renaming or shelving a shared board affects everyone on it, so it stays
	// with the owner even though collaborators may edit every card on it.
	if (boardRole(boardId, userId) !== 'owner') return null;
	const set: Partial<Board> = { updatedAt: new Date() };
	if (patch.name !== undefined) set.name = patch.name.trim() || 'Untitled board';
	if (patch.description !== undefined) set.description = patch.description.trim();
	if (patch.archived !== undefined) set.archivedAt = patch.archived ? new Date() : null;
	db.update(boards).set(set).where(eq(boards.id, boardId)).run();
	return db.select().from(boards).where(eq(boards.id, boardId)).get() ?? null;
}

export function deleteBoard(boardId: string, userId: string): boolean {
	if (boardRole(boardId, userId) !== 'owner') return false;
	const ids = db
		.select({ id: cards.id })
		.from(cards)
		.where(eq(cards.boardId, boardId))
		.all()
		.map((c) => c.id);
	db.transaction((tx) => {
		if (ids.length) {
			tx.delete(cardLog).where(inArray(cardLog.cardId, ids)).run();
			tx.delete(cardAttachments).where(inArray(cardAttachments.cardId, ids)).run();
		}
		tx.delete(cards).where(eq(cards.boardId, boardId)).run();
		tx.delete(boardLanes).where(eq(boardLanes.boardId, boardId)).run();
		tx.delete(boardStatuses).where(eq(boardStatuses.boardId, boardId)).run();
		tx.delete(boardMembers).where(eq(boardMembers.boardId, boardId)).run();
		tx.delete(boards).where(eq(boards.id, boardId)).run();
	});
	for (const id of ids) rmSync(cardUploadsDir(id), { recursive: true, force: true });
	return true;
}

// --- members --------------------------------------------------------------

export interface BoardMember {
	userId: string;
	username: string;
	displayName: string | null;
	role: BoardRole;
}

export function listMembers(boardId: string, userId: string): BoardMember[] | null {
	if (!boardRole(boardId, userId)) return null;
	return db
		.select({
			userId: boardMembers.userId,
			role: boardMembers.role,
			username: users.username,
			displayName: users.displayName
		})
		.from(boardMembers)
		.leftJoin(users, eq(users.id, boardMembers.userId))
		.where(eq(boardMembers.boardId, boardId))
		.all()
		.map((r) => ({
			userId: r.userId,
			role: r.role,
			// A member row can outlive its user row only if an account is removed
			// outside Galaxy; show the id rather than an empty cell.
			username: r.username ?? r.userId,
			displayName: r.displayName
		}));
}

export type InviteResult =
	| { ok: true; member: BoardMember }
	| { ok: false; reason: 'forbidden' | 'no-such-user' | 'already-member' };

/**
 * Invite by username, because that is the name Authelia gives people and the
 * only handle either user actually knows. There is no invite email — the other
 * person simply finds the board in their picker next time they look.
 */
export function addMember(boardId: string, userId: string, username: string): InviteResult {
	if (boardRole(boardId, userId) !== 'owner') return { ok: false, reason: 'forbidden' };
	const target = db
		.select()
		.from(users)
		.where(eq(users.username, username.trim().toLowerCase()))
		.get();
	if (!target) return { ok: false, reason: 'no-such-user' };
	if (boardRole(boardId, target.id)) return { ok: false, reason: 'already-member' };
	db.insert(boardMembers)
		.values({ boardId, userId: target.id, role: 'collaborator', createdAt: new Date() })
		.run();
	return {
		ok: true,
		member: {
			userId: target.id,
			username: target.username,
			displayName: target.displayName,
			role: 'collaborator'
		}
	};
}

export function removeMember(boardId: string, userId: string, targetId: string): boolean {
	// Leaving a board yourself is always allowed; removing someone else is the
	// owner's call. Either way the owner cannot be removed — that would leave
	// the board with no one who can manage it.
	const self = targetId === userId;
	if (!self && boardRole(boardId, userId) !== 'owner') return false;
	if (boardRole(boardId, targetId) === 'owner') return false;
	const res = db
		.delete(boardMembers)
		.where(and(eq(boardMembers.boardId, boardId), eq(boardMembers.userId, targetId)))
		.run();
	return res.changes > 0;
}

// --- lanes and statuses ---------------------------------------------------

export function listLanes(boardId: string): BoardLane[] {
	return db
		.select()
		.from(boardLanes)
		.where(eq(boardLanes.boardId, boardId))
		.orderBy(asc(boardLanes.position))
		.all();
}

export function listStatuses(boardId: string): BoardStatus[] {
	return db
		.select()
		.from(boardStatuses)
		.where(eq(boardStatuses.boardId, boardId))
		.orderBy(asc(boardStatuses.position))
		.all();
}

export type LaneResult = { ok: true; lane: BoardLane } | { ok: false; reason: 'forbidden' | 'limit' };

export function addLane(boardId: string, userId: string, name: string): LaneResult {
	if (!boardRole(boardId, userId)) return { ok: false, reason: 'forbidden' };
	const existing = listLanes(boardId);
	if (existing.length >= MAX_LANES) return { ok: false, reason: 'limit' };
	const lane: BoardLane = {
		id: randomUUID(),
		boardId,
		name: name.trim() || `Lane ${existing.length + 1}`,
		position: existing.length
	};
	db.insert(boardLanes).values(lane).run();
	return { ok: true, lane };
}

export function renameLane(laneId: string, userId: string, name: string): BoardLane | null {
	const lane = db.select().from(boardLanes).where(eq(boardLanes.id, laneId)).get();
	if (!lane || !boardRole(lane.boardId, userId)) return null;
	db.update(boardLanes)
		.set({ name: name.trim() || lane.name })
		.where(eq(boardLanes.id, laneId))
		.run();
	return db.select().from(boardLanes).where(eq(boardLanes.id, laneId)).get() ?? null;
}

/**
 * Remove a lane, moving its cards to the lane on its left (or right, for the
 * first one). Deleting a column should not silently delete work.
 */
export function deleteLane(laneId: string, userId: string): boolean {
	const lane = db.select().from(boardLanes).where(eq(boardLanes.id, laneId)).get();
	if (!lane || !boardRole(lane.boardId, userId)) return false;
	const lanes = listLanes(lane.boardId);
	if (lanes.length <= 1) return false; // a board with no lanes has nowhere to put a card
	const idx = lanes.findIndex((l) => l.id === laneId);
	const fallback = lanes[idx - 1] ?? lanes[idx + 1];
	db.transaction((tx) => {
		tx.update(cards).set({ laneId: fallback.id }).where(eq(cards.laneId, laneId)).run();
		tx.delete(boardLanes).where(eq(boardLanes.id, laneId)).run();
		for (const [i, l] of lanes.filter((l) => l.id !== laneId).entries()) {
			tx.update(boardLanes).set({ position: i }).where(eq(boardLanes.id, l.id)).run();
		}
	});
	renumber(fallback.id);
	return true;
}

export function addStatus(
	boardId: string,
	userId: string,
	opts: { name: string; colour?: string; isDone?: boolean }
): BoardStatus | null {
	if (!boardRole(boardId, userId)) return null;
	const existing = listStatuses(boardId);
	const status: BoardStatus = {
		id: randomUUID(),
		boardId,
		name: opts.name.trim() || `Status ${existing.length + 1}`,
		colour: opts.colour ?? '',
		position: existing.length,
		isDone: opts.isDone ?? false
	};
	db.insert(boardStatuses).values(status).run();
	return status;
}

export function updateStatus(
	statusId: string,
	userId: string,
	patch: { name?: string; colour?: string; isDone?: boolean }
): BoardStatus | null {
	const status = db.select().from(boardStatuses).where(eq(boardStatuses.id, statusId)).get();
	if (!status || !boardRole(status.boardId, userId)) return null;
	const set: Partial<BoardStatus> = {};
	if (patch.name !== undefined) set.name = patch.name.trim() || status.name;
	if (patch.colour !== undefined) set.colour = patch.colour;
	if (patch.isDone !== undefined) set.isDone = patch.isDone;
	db.update(boardStatuses).set(set).where(eq(boardStatuses.id, statusId)).run();
	return db.select().from(boardStatuses).where(eq(boardStatuses.id, statusId)).get() ?? null;
}

/** Cards on a deleted status fall back to the board's first status. */
export function deleteStatus(statusId: string, userId: string): boolean {
	const status = db.select().from(boardStatuses).where(eq(boardStatuses.id, statusId)).get();
	if (!status || !boardRole(status.boardId, userId)) return false;
	const statuses = listStatuses(status.boardId);
	if (statuses.length <= 1) return false;
	const fallback = statuses.find((s) => s.id !== statusId)!;
	db.transaction((tx) => {
		tx.update(cards).set({ statusId: fallback.id }).where(eq(cards.statusId, statusId)).run();
		tx.delete(boardStatuses).where(eq(boardStatuses.id, statusId)).run();
		for (const [i, s] of statuses.filter((s) => s.id !== statusId).entries()) {
			tx.update(boardStatuses).set({ position: i }).where(eq(boardStatuses.id, s.id)).run();
		}
	});
	return true;
}

// --- cards ----------------------------------------------------------------

export function listCards(boardId: string): Card[] {
	return db
		.select()
		.from(cards)
		.where(and(eq(cards.boardId, boardId), isNull(cards.archivedAt)))
		.orderBy(asc(cards.position), asc(cards.createdAt))
		.all();
}

export function listArchivedCards(boardId: string, limit = 200): Card[] {
	return db
		.select()
		.from(cards)
		.where(and(eq(cards.boardId, boardId), isNotNull(cards.archivedAt)))
		// Ties broken on id so a page-refresh never reshuffles two cards archived
		// in the same millisecond.
		.orderBy(desc(cards.archivedAt), desc(cards.id))
		.limit(limit)
		.all();
}

/** A card plus everything the detail view and an agent both want. */
export function getCard(
	cardId: string,
	userId: string
): { card: Card; log: CardLogEntry[]; attachments: CardAttachment[]; role: BoardRole } | null {
	const card = db.select().from(cards).where(eq(cards.id, cardId)).get();
	if (!card) return null;
	const role = boardRole(card.boardId, userId);
	if (!role) return null;
	return {
		card,
		role,
		log: db
			.select()
			.from(cardLog)
			.where(eq(cardLog.cardId, cardId))
			// Insertion order, not clock order: one update writes several lines in
			// the same millisecond ("status", then "archived"), and a tie broken on
			// a random uuid would reorder cause and effect.
			.orderBy(asc(cardLog.createdAt), sql`rowid`)
			.all(),
		attachments: db.select().from(cardAttachments).where(eq(cardAttachments.cardId, cardId)).all()
	};
}

export function createCard(
	boardId: string,
	userId: string,
	opts: {
		title: string;
		description?: string;
		laneId?: string;
		statusId?: string;
		priority?: CardPriority;
		assignedTo?: string | null;
	}
): Card | null {
	if (!boardRole(boardId, userId)) return null;
	const lanes = listLanes(boardId);
	const statuses = listStatuses(boardId);
	if (!lanes.length || !statuses.length) return null;
	const lane = lanes.find((l) => l.id === opts.laneId) ?? lanes[0];
	// A new card starts in the first non-done status — creating something
	// already finished is never what was meant.
	const status =
		statuses.find((s) => s.id === opts.statusId) ?? statuses.find((s) => !s.isDone) ?? statuses[0];
	const now = new Date();
	const card: Card = {
		id: randomUUID(),
		boardId,
		laneId: lane.id,
		statusId: status.id,
		title: opts.title.trim() || 'Untitled',
		description: opts.description?.trim() ?? '',
		priority: opts.priority ?? 'none',
		position: nextPosition(lane.id),
		createdBy: userId,
		assignedTo: opts.assignedTo ?? null,
		archivedAt: status.isDone ? now : null,
		createdAt: now,
		updatedAt: now
	};
	db.insert(cards).values(card).run();
	logCard(card.id, { actor: 'user', userId, event: 'created', detail: card.title });
	return card;
}

export interface CardPatch {
	title?: string;
	description?: string;
	laneId?: string;
	statusId?: string;
	priority?: CardPriority;
	assignedTo?: string | null;
	/** Index within the target lane; omitted means "leave where it is". */
	position?: number;
	archived?: boolean;
}

/**
 * Apply a change and record it. Every field that moves writes its own Log line,
 * because the Log is what an agent reads to find out what has already happened
 * to a card — "updated" would tell it nothing.
 */
export function updateCard(
	cardId: string,
	userId: string,
	patch: CardPatch,
	actor: 'user' | 'agent' = 'user'
): Card | null {
	const card = db.select().from(cards).where(eq(cards.id, cardId)).get();
	if (!card || !boardRole(card.boardId, userId)) return null;

	const set: Partial<Card> = { updatedAt: new Date() };
	const notes: { event: string; detail: string }[] = [];
	const lanes = listLanes(card.boardId);
	const statuses = listStatuses(card.boardId);

	if (patch.title !== undefined && patch.title.trim() && patch.title.trim() !== card.title) {
		set.title = patch.title.trim();
		notes.push({ event: 'renamed', detail: `${card.title} → ${set.title}` });
	}
	if (patch.description !== undefined && patch.description !== card.description) {
		set.description = patch.description;
		notes.push({ event: 'described', detail: '' });
	}
	if (patch.priority !== undefined && patch.priority !== card.priority) {
		set.priority = patch.priority;
		notes.push({ event: 'priority', detail: `${card.priority} → ${patch.priority}` });
	}
	if (patch.assignedTo !== undefined && patch.assignedTo !== card.assignedTo) {
		set.assignedTo = patch.assignedTo;
		notes.push({ event: 'assigned', detail: patch.assignedTo ? nameOf(patch.assignedTo) : 'nobody' });
	}

	const targetLane = patch.laneId ? lanes.find((l) => l.id === patch.laneId) : undefined;
	if (targetLane && targetLane.id !== card.laneId) {
		set.laneId = targetLane.id;
		notes.push({
			event: 'moved',
			detail: `${lanes.find((l) => l.id === card.laneId)?.name ?? '?'} → ${targetLane.name}`
		});
	}

	const targetStatus = patch.statusId ? statuses.find((s) => s.id === patch.statusId) : undefined;
	if (targetStatus && targetStatus.id !== card.statusId) {
		set.statusId = targetStatus.id;
		notes.push({
			event: 'status',
			detail: `${statuses.find((s) => s.id === card.statusId)?.name ?? '?'} → ${targetStatus.name}`
		});
		// Reaching a done status is what archives a card — the board shows work in
		// hand, and finished cards go to the archive without a second action.
		if (targetStatus.isDone && !card.archivedAt) {
			set.archivedAt = new Date();
			notes.push({ event: 'archived', detail: `completed as ${targetStatus.name}` });
		} else if (!targetStatus.isDone && card.archivedAt) {
			set.archivedAt = null;
			notes.push({ event: 'restored', detail: '' });
		}
	}

	if (patch.archived !== undefined && patch.archived !== !!card.archivedAt) {
		set.archivedAt = patch.archived ? new Date() : null;
		notes.push({ event: patch.archived ? 'archived' : 'restored', detail: '' });
	}

	db.update(cards).set(set).where(eq(cards.id, cardId)).run();

	// Ordering is rewritten after the row moves so the renumber sees final state.
	if (patch.position !== undefined || set.laneId) {
		reposition(cardId, set.laneId ?? card.laneId, patch.position);
	}
	for (const n of notes) logCard(cardId, { actor, userId, ...n });
	return db.select().from(cards).where(eq(cards.id, cardId)).get() ?? null;
}

export function deleteCard(cardId: string, userId: string): boolean {
	const card = db.select().from(cards).where(eq(cards.id, cardId)).get();
	if (!card || !boardRole(card.boardId, userId)) return false;
	db.transaction((tx) => {
		tx.delete(cardLog).where(eq(cardLog.cardId, cardId)).run();
		tx.delete(cardAttachments).where(eq(cardAttachments.cardId, cardId)).run();
		tx.delete(cards).where(eq(cards.id, cardId)).run();
	});
	rmSync(cardUploadsDir(cardId), { recursive: true, force: true });
	renumber(card.laneId);
	return true;
}

// --- log ------------------------------------------------------------------

export function logCard(
	cardId: string,
	entry: { actor: 'user' | 'agent'; userId?: string | null; event: string; detail?: string }
): CardLogEntry {
	const row: CardLogEntry = {
		id: randomUUID(),
		cardId,
		actor: entry.actor,
		userId: entry.userId ?? null,
		event: entry.event,
		detail: entry.detail ?? '',
		createdAt: new Date()
	};
	db.insert(cardLog).values(row).run();
	return row;
}

// --- attachments ----------------------------------------------------------

export function addCardAttachment(
	cardId: string,
	userId: string,
	file: { name: string; mime: string; data: Buffer; kind: 'image' | 'document'; text: string }
): CardAttachment | null {
	const card = db.select().from(cards).where(eq(cards.id, cardId)).get();
	if (!card || !boardRole(card.boardId, userId)) return null;
	const id = randomUUID();
	const dir = cardUploadsDir(cardId);
	mkdirSync(dir, { recursive: true });
	const safeName = file.name.replace(/[^\w.-]/g, '_').slice(0, 80);
	const path = join(dir, `${id}-${safeName}`);
	writeFileSync(path, file.data);
	const row: CardAttachment = {
		id,
		cardId,
		name: file.name,
		mime: file.mime,
		size: file.data.length,
		path,
		kind: file.kind,
		extractedText: file.text || null,
		textChars: file.text.length,
		createdAt: new Date()
	};
	db.insert(cardAttachments).values(row).run();
	logCard(cardId, { actor: 'user', userId, event: 'attached', detail: file.name });
	return row;
}

export function deleteCardAttachment(attachmentId: string, userId: string): boolean {
	const row = db.select().from(cardAttachments).where(eq(cardAttachments.id, attachmentId)).get();
	if (!row) return false;
	const card = db.select().from(cards).where(eq(cards.id, row.cardId)).get();
	if (!card || !boardRole(card.boardId, userId)) return false;
	db.delete(cardAttachments).where(eq(cardAttachments.id, attachmentId)).run();
	rmSync(row.path, { force: true });
	return true;
}

// --- ordering -------------------------------------------------------------

function nextPosition(laneId: string): number {
	const row = db
		.select({ max: sql<number | null>`max(${cards.position})` })
		.from(cards)
		.where(eq(cards.laneId, laneId))
		.get();
	return (row?.max ?? -1) + 1;
}

/** Move a card to `index` within its lane and renumber that lane from 0. */
function reposition(cardId: string, laneId: string, index?: number): void {
	const inLane = db
		.select({ id: cards.id })
		.from(cards)
		.where(eq(cards.laneId, laneId))
		.orderBy(asc(cards.position), asc(cards.createdAt))
		.all()
		.map((c) => c.id)
		.filter((id) => id !== cardId);
	const at = index === undefined ? inLane.length : Math.max(0, Math.min(index, inLane.length));
	inLane.splice(at, 0, cardId);
	db.transaction((tx) => {
		for (const [i, id] of inLane.entries()) {
			tx.update(cards).set({ position: i }).where(eq(cards.id, id)).run();
		}
	});
}

/** Close the gap a removed card left behind. */
function renumber(laneId: string): void {
	const inLane = db
		.select({ id: cards.id })
		.from(cards)
		.where(eq(cards.laneId, laneId))
		.orderBy(asc(cards.position), asc(cards.createdAt))
		.all();
	db.transaction((tx) => {
		for (const [i, c] of inLane.entries()) {
			tx.update(cards).set({ position: i }).where(eq(cards.id, c.id)).run();
		}
	});
}

function nameOf(userId: string): string {
	return db.select().from(users).where(eq(users.id, userId)).get()?.username ?? userId;
}
