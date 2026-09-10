import { describe, expect, it, vi } from 'vitest';
import { isDismissSwipe, pageList, registerPageList, SWIPE_CLOSE_PX } from './list-sheet.svelte';

const at = (x: number, y: number) => ({ x, y });

describe('isDismissSwipe', () => {
	it('closes on a decisive drag back towards the edge it came from', () => {
		expect(isDismissSwipe(at(200, 400), at(200 - SWIPE_CLOSE_PX - 1, 400))).toBe(true);
	});

	it('ignores a drag that has not gone far enough to be meant', () => {
		expect(isDismissSwipe(at(200, 400), at(180, 400))).toBe(false);
	});

	it('ignores a drag the other way', () => {
		expect(isDismissSwipe(at(200, 400), at(300, 400))).toBe(false);
	});

	it('leaves a scroll alone even when it drifts sideways', () => {
		// The case this predicate exists for. Thumbs do not travel in straight
		// lines, so a flick down the list picks up 50-odd pixels of sideways
		// drift — and closing the sheet under it loses the row being reached for.
		expect(isDismissSwipe(at(200, 400), at(140, 620))).toBe(false);
	});

	it('closes on a diagonal that is mostly sideways', () => {
		expect(isDismissSwipe(at(200, 400), at(120, 420))).toBe(true);
	});

	it('takes a threshold, so a wider sheet can ask for more travel', () => {
		expect(isDismissSwipe(at(200, 400), at(140, 400), 100)).toBe(false);
		expect(isDismissSwipe(at(200, 400), at(60, 400), 100)).toBe(true);
	});
});

describe('the page list registry', () => {
	it('reports nothing registered on a page with no list', () => {
		// Boards and Settings have no list, and the tab bar has to know: tapping
		// the tab you are on should navigate rather than silently do nothing.
		expect(pageList.present).toBe(false);
	});

	it('opens whatever the mounted page registered', () => {
		const open = vi.fn();
		const off = registerPageList(open);
		expect(pageList.present).toBe(true);
		pageList.toggle();
		expect(open).toHaveBeenCalledTimes(1);
		off();
		expect(pageList.present).toBe(false);
	});

	it('does nothing, rather than throwing, once the page is gone', () => {
		const off = registerPageList(vi.fn());
		off();
		expect(() => pageList.toggle()).not.toThrow();
	});

	it('keeps the incoming page’s registration when the outgoing one tears down', () => {
		// Svelte mounts the new page before unmounting the old one, so the old
		// teardown runs last. An unconditional clear there would wipe the
		// registration the new page had just made, and the tab would open
		// nothing for the rest of the session.
		const oldPage = vi.fn();
		const newPage = vi.fn();
		const offOld = registerPageList(oldPage);
		const offNew = registerPageList(newPage);

		offOld();

		expect(pageList.present).toBe(true);
		pageList.toggle();
		expect(newPage).toHaveBeenCalledTimes(1);
		expect(oldPage).not.toHaveBeenCalled();
		offNew();
	});
});
