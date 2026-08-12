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
 * Used to abandon the press-and-hold when a touch turns into a scroll.
 */
export function movedBeyond(
	from: { x: number; y: number },
	to: { x: number; y: number },
	tolerance: number
): boolean {
	return Math.abs(to.x - from.x) > tolerance || Math.abs(to.y - from.y) > tolerance;
}
