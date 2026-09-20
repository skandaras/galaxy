/**
 * The rules of dragging a document around the shelf, kept out of the page so
 * they can be tested without a browser — the same split `board-drag.ts` makes,
 * and for the same reason: the geometry is obvious and the rules are not.
 */

import { nestableUnder, UNFILED, type TreeDoc } from './library-tree';

/**
 * Press and hold, rather than the browser's own drag, because HTML5 drag
 * events do not fire for a finger and half of this app is used on a phone.
 * Both numbers are the board's, which is where the gesture was already proved
 * under a thumb: long enough that a press is not a tap, loose enough that a
 * scroll is not a drag.
 */
export const HOLD_MS = 180;
export const MOVE_TOLERANCE = 8;

/** What the pointer is over: a folder heading, a document row, or neither. */
export type DropTarget = { folder: string } | { docId: string } | null;

/** Where the dropped document is asked to go. */
export type Filing = { parentId: string } | { folder: string };

/**
 * What a drop asks the server for, or null when it asks for nothing.
 *
 * Null covers a refusal and a no-op alike, because on screen they are the same
 * thing: the target does not light up. A drop that would make a cycle is then
 * something you can see is not on offer, instead of an error that arrives
 * after you let go.
 */
export function dropDestination<D extends TreeDoc>(
	docs: D[],
	draggedId: string,
	target: DropTarget
): Filing | null {
	const dragged = docs.find((d) => d.id === draggedId);
	if (!dragged || !target) return null;

	if ('folder' in target) {
		// The heading says Unfiled; the row holds an empty label. This is the one
		// place that translation happens.
		const folder = target.folder === UNFILED ? '' : target.folder;
		// Already a root of that folder, so there is nowhere for it to land.
		if (!dragged.parentId && dragged.folder === folder) return null;
		return { folder };
	}

	if (target.docId === dragged.parentId) return null;
	// Its own descendants and anything at the depth floor are not parents, which
	// is the same list the filing picker offers.
	if (!nestableUnder(docs, draggedId).some((d) => d.id === target.docId)) return null;
	return { parentId: target.docId };
}
