import { describe, expect, it } from 'vitest';
import { dropIndex, isNoOp, movedBeyond, type CardBox } from './board-drag';

/** Three 40px cards stacked from y=0, midpoints at 20, 60 and 100. */
const LANE: CardBox[] = [
	{ id: 'a', top: 0, bottom: 40 },
	{ id: 'b', top: 40, bottom: 80 },
	{ id: 'c', top: 80, bottom: 120 }
];

describe('dropIndex', () => {
	it('lands above a card when the pointer is in its top half', () => {
		expect(dropIndex(LANE, 5, 'x')).toBe(0);
		expect(dropIndex(LANE, 45, 'x')).toBe(1);
	});

	it('lands below a card when the pointer is past its middle', () => {
		expect(dropIndex(LANE, 25, 'x')).toBe(1);
		expect(dropIndex(LANE, 110, 'x')).toBe(3);
	});

	it('appends when the pointer is below every card', () => {
		expect(dropIndex(LANE, 500, 'x')).toBe(3);
		expect(dropIndex([], 500, 'x')).toBe(0);
	});

	it('counts positions without the card being dragged', () => {
		// The index is spliced into the lane minus that card, so dropping 'a'
		// back on itself has to come out as 0, not 1.
		expect(dropIndex(LANE, 5, 'a')).toBe(0);
		expect(dropIndex(LANE, 25, 'a')).toBe(0);
		// Dragging the top card to the bottom of a three-card lane: two others.
		expect(dropIndex(LANE, 500, 'a')).toBe(2);
	});

	it('is stable for a card dropped back where it started', () => {
		// Every card, released over its own middle, must report its own index.
		expect(dropIndex(LANE, 20, 'a')).toBe(0);
		expect(dropIndex(LANE, 60, 'b')).toBe(1);
		expect(dropIndex(LANE, 100, 'c')).toBe(2);
	});
});

describe('isNoOp', () => {
	it('spots a drop that changes nothing', () => {
		expect(isNoOp({ laneId: 'l1', index: 2 }, { laneId: 'l1', index: 2 })).toBe(true);
	});

	it('treats a different lane or slot as a real move', () => {
		expect(isNoOp({ laneId: 'l1', index: 2 }, { laneId: 'l2', index: 2 })).toBe(false);
		expect(isNoOp({ laneId: 'l1', index: 2 }, { laneId: 'l1', index: 3 })).toBe(false);
	});
});

describe('movedBeyond', () => {
	it('ignores the jitter of a press', () => {
		expect(movedBeyond({ x: 100, y: 100 }, { x: 104, y: 103 }, 8)).toBe(false);
	});

	it('catches a scroll or a drag starting in either axis', () => {
		expect(movedBeyond({ x: 100, y: 100 }, { x: 100, y: 130 }, 8)).toBe(true);
		expect(movedBeyond({ x: 100, y: 100 }, { x: 60, y: 100 }, 8)).toBe(true);
	});
});
