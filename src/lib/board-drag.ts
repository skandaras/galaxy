/**
 * Geometry for dragging a card around a board.
 *
 * Kept out of the component because this is the part that is easy to get
 * subtly wrong — off-by-one on the insertion index, or an index that counts
 * the card being dragged — and the part worth testing without a browser.
 */

export interface CardBox {
	id: string;
	top: number;
	bottom: number;
}

/**
 * Where a card released at `y` should land in a lane.
 *
 * The returned index is into the lane *without* the dragged card, which is
 * exactly what the server's `reposition` splices into — so dropping a card
 * back where it started returns the index it already had.
 */
export function dropIndex(boxes: CardBox[], y: number, draggedId: string): number {
	let index = 0;
	for (const box of boxes) {
		if (box.id === draggedId) continue;
		// Past a card's midpoint means below it; anything above stops the count.
		if (y > (box.top + box.bottom) / 2) index++;
		else break;
	}
	return index;
}

/** True when a drop would leave the card exactly where it already is. */
export function isNoOp(
	from: { laneId: string; index: number },
	to: { laneId: string; index: number }
): boolean {
	return from.laneId === to.laneId && from.index === to.index;
}

/**
 * Has the pointer moved far enough to mean "drag" rather than "click"?
 * Ends the hold when a touch turns into a scroll, and starts a mouse drag.
 */
export function movedBeyond(
	from: { x: number; y: number },
	to: { x: number; y: number },
	tolerance: number
): boolean {
	return Math.abs(to.x - from.x) > tolerance || Math.abs(to.y - from.y) > tolerance;
}

/** How far a finger may wander during the hold before it counts as a scroll. */
export const MOVE_TOLERANCE = 8;
/** How far a mouse must move with the button down before it counts as a drag. */
export const DRAG_START = 4;

/**
 * What a press that has not yet become a drag should do as the pointer moves.
 *
 * A mouse starts dragging as soon as it moves: it cannot scroll the page by
 * dragging, so there is nothing to tell apart and the hold was only a wait.
 * Touch and pen keep the hold, and moving before it fires is a scroll.
 * Staying within the threshold either way leaves it a click.
 */
export function pressOutcome(
	pointerType: string,
	from: { x: number; y: number },
	to: { x: number; y: number }
): 'drag' | 'abandon' | 'wait' {
	if (pointerType === 'mouse') return movedBeyond(from, to, DRAG_START) ? 'drag' : 'wait';
	return movedBeyond(from, to, MOVE_TOLERANCE) ? 'abandon' : 'wait';
}
