/**
 * Shapes the board API returns, shared by the page and its components.
 * Timestamps arrive as epoch milliseconds, since that is what JSON gives us
 * back from the timestamp_ms columns.
 */

export type BoardRole = 'owner' | 'collaborator';
export type CardPriority = 'none' | 'low' | 'medium' | 'high' | 'urgent';

export interface Board {
	id: string;
	ownerId: string;
	name: string;
	description: string;
	archivedAt: number | null;
	createdAt: number;
	updatedAt: number;
	/** Present on the list endpoint, which joins membership in. */
	role?: BoardRole;
}

export interface Lane {
	id: string;
	boardId: string;
	name: string;
	position: number;
}

export interface Status {
	id: string;
	boardId: string;
	name: string;
	colour: string;
	position: number;
	isDone: boolean;
}

export interface Project {
	id: string;
	boardId: string;
	name: string;
	colour: string;
	position: number;
}

export interface Card {
	id: string;
	boardId: string;
	laneId: string;
	statusId: string;
	projectId: string | null;
	title: string;
	description: string;
	priority: CardPriority;
	position: number;
	createdBy: string;
	assignedTo: string | null;
	archivedAt: number | null;
	createdAt: number;
	updatedAt: number;
}

export interface CardLogEntry {
	id: string;
	cardId: string;
	actor: 'user' | 'agent';
	userId: string | null;
	event: string;
	detail: string;
	createdAt: number;
}

export interface CardAttachment {
	id: string;
	name: string;
	mime: string;
	size: number;
	kind: 'image' | 'document';
}

export interface Member {
	userId: string;
	username: string;
	displayName: string | null;
	role: BoardRole;
}

export interface BoardView {
	board: Board;
	role: BoardRole;
	lanes: Lane[];
	statuses: Status[];
	projects: Project[];
	cards: Card[];
	members: Member[];
	archived: Card[];
}

/** Ordered worst-to-best so a sort by index reads as "most urgent first". */
export const PRIORITIES: CardPriority[] = ['urgent', 'high', 'medium', 'low', 'none'];

export const PRIORITY_LABEL: Record<CardPriority, string> = {
	urgent: 'Urgent',
	high: 'High',
	medium: 'Medium',
	low: 'Low',
	none: 'No priority'
};

/** A short mark for the card face, where a full word would crowd the title. */
export const PRIORITY_MARK: Record<CardPriority, string> = {
	urgent: '!!!',
	high: '!!',
	medium: '!',
	low: '·',
	none: ''
};

/**
 * The assignee filter on a board.
 *
 * Pure and separate from the page for the same reason `board-drag` is: it has
 * edge cases worth pinning down (nobody selected, cards nobody has picked up,
 * a filter pointing at someone who has since left) and none of them need a
 * browser to check.
 */

/** Cards nobody has picked up. A real choice, not the absence of one. */
export const UNASSIGNED = '\u0000unassigned';

/** No filter at all — everyone's cards. */
export const EVERYONE = '';

export function matchesAssignee(card: Pick<Card, 'assignedTo'>, assignee: string): boolean {
	if (assignee === EVERYONE) return true;
	if (assignee === UNASSIGNED) return !card.assignedTo;
	return card.assignedTo === assignee;
}

/**
 * Validate a filter restored from storage against who is actually on the board.
 *
 * A filter naming someone who has since been removed would hide every card
 * with nothing on screen explaining why, so it falls back to everyone.
 */
export function resolveAssignee(saved: string | null, members: { userId: string }[]): string {
	if (!saved) return EVERYONE;
	if (saved === UNASSIGNED) return UNASSIGNED;
	return members.some((m) => m.userId === saved) ? saved : EVERYONE;
}
