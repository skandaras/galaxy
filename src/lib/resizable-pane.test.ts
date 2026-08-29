import { describe, expect, it } from 'vitest';
import { createResizablePane, type PaneStorage } from './resizable-pane.svelte';

/** In-memory stand-in for localStorage, so no test touches the real one. */
function storage(seed: Record<string, string> = {}): PaneStorage & { data: Record<string, string> } {
	const data = { ...seed };
	return {
		data,
		getItem: (k: string) => (k in data ? data[k] : null),
		setItem: (k: string, v: string) => {
			data[k] = v;
		}
	};
}

const KEY = 'galaxy:test-width';
const opts = { key: KEY, min: 200, max: 400, initial: 300 };

/** Arrow-key press, since that is the only resize path with no DOM behind it. */
const arrow = (key: string, shiftKey = false) =>
	({ key, shiftKey, preventDefault: () => {} }) as KeyboardEvent;

describe('createResizablePane', () => {
	it('starts at the initial width when nothing is stored', () => {
		expect(createResizablePane({ ...opts, storage: storage() }).width).toBe(300);
	});

	it('restores a stored width', () => {
		const pane = createResizablePane({ ...opts, storage: storage({ [KEY]: '355' }) });
		expect(pane.width).toBe(355);
	});

	it('re-clamps a stored width, so a value saved under old bounds still fits', () => {
		// The bounds can change between releases; trusting the stored number
		// would restore a pane that cannot be dragged back into range.
		expect(createResizablePane({ ...opts, storage: storage({ [KEY]: '9999' }) }).width).toBe(400);
		expect(createResizablePane({ ...opts, storage: storage({ [KEY]: '10' }) }).width).toBe(200);
	});

	it('ignores a corrupt or absent stored value', () => {
		for (const bad of ['', 'wide', '0', '-40', 'NaN']) {
			expect(createResizablePane({ ...opts, storage: storage({ [KEY]: bad }) }).width).toBe(300);
		}
	});

	it('nudges by 10, or 40 with shift, and clamps at both ends', () => {
		const pane = createResizablePane({ ...opts, storage: storage() });
		pane.nudge(arrow('ArrowLeft'));
		expect(pane.width).toBe(290);
		pane.nudge(arrow('ArrowRight', true));
		expect(pane.width).toBe(330);

		for (let i = 0; i < 20; i++) pane.nudge(arrow('ArrowRight', true));
		expect(pane.width).toBe(400);
		for (let i = 0; i < 20; i++) pane.nudge(arrow('ArrowLeft', true));
		expect(pane.width).toBe(200);
	});

	it('ignores keys that are not the arrows it handles', () => {
		const pane = createResizablePane({ ...opts, storage: storage() });
		pane.nudge(arrow('Enter'));
		pane.nudge(arrow('ArrowUp'));
		expect(pane.width).toBe(300);
	});

	it('persists after a keyboard resize', () => {
		const store = storage();
		const pane = createResizablePane({ ...opts, storage: store });
		pane.nudge(arrow('ArrowLeft'));
		expect(store.data[KEY]).toBe('290');
		expect(createResizablePane({ ...opts, storage: store }).width).toBe(290);
	});

	it('works with no storage at all, so a blocked localStorage is not a crash', () => {
		const pane = createResizablePane({ ...opts, storage: null });
		pane.nudge(arrow('ArrowLeft'));
		expect(pane.width).toBe(290);
	});

	it('survives storage that throws on read and on write', () => {
		const hostile: PaneStorage = {
			getItem: () => {
				throw new Error('blocked');
			},
			setItem: () => {
				throw new Error('blocked');
			}
		};
		const pane = createResizablePane({ ...opts, storage: hostile });
		expect(pane.width).toBe(300);
		pane.nudge(arrow('ArrowRight'));
		expect(pane.width).toBe(310);
	});
});

describe('which side the pane is on', () => {
	/** A pointerdown/move pair, since the handle drives both through events. */
	function drag(pane: ReturnType<typeof createResizablePane>, dx: number) {
		const listeners: Record<string, (e: never) => void> = {};
		const handle = {
			setPointerCapture() {},
			releasePointerCapture() {},
			addEventListener: (type: string, fn: (e: never) => void) => (listeners[type] = fn),
			removeEventListener() {}
		};
		pane.start({
			clientX: 100,
			pointerId: 1,
			currentTarget: handle,
			preventDefault() {}
		} as never);
		listeners.pointermove?.({ clientX: 100 + dx } as never);
		return pane.width;
	}

	it('widens to the right when the pane is left of the handle', () => {
		const pane = createResizablePane({
			key: 'k',
			min: 100,
			max: 600,
			initial: 300,
			storage: null
		});
		expect(drag(pane, 50)).toBe(350);
	});

	it('widens to the left when the pane is right of the handle', () => {
		// Cortex's panel. Dragging toward the panel used to widen it, which is
		// backwards from every other handle in the app.
		const right = () =>
			createResizablePane({
				key: 'k',
				anchor: 'right',
				min: 100,
				max: 600,
				initial: 300,
				storage: null
			});
		// A pane each, since a drag leaves the width where it put it.
		expect(drag(right(), 50)).toBe(250);
		expect(drag(right(), -50)).toBe(350);
	});

	it('turns the arrow keys round with it', () => {
		const pane = createResizablePane({
			key: 'k',
			anchor: 'right',
			min: 100,
			max: 600,
			initial: 300,
			storage: null
		});
		pane.nudge({ key: 'ArrowLeft', preventDefault() {} } as never);
		// Left grows a right-anchored pane, because left is toward its edge.
		expect(pane.width).toBe(310);
	});
});
