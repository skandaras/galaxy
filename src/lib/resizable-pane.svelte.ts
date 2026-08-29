/**
 * A list pane whose width is dragged from a divider and remembered per browser.
 *
 * Extracted from the chat page, which had the only working implementation, so
 * /code and /library get the same behaviour rather than three near-copies that
 * drift. The width is a preference about one screen on one machine — it is kept
 * in localStorage rather than being sent to the server for a round trip.
 */

/** Storage this needs, so a test can hand it a plain object. */
export type PaneStorage = Pick<Storage, 'getItem' | 'setItem'>;

export interface ResizablePane {
	/** Current width in px, already clamped. */
	readonly width: number;
	/** True while a pointer drag is in flight, for the handle's active styling. */
	readonly dragging: boolean;
	readonly min: number;
	readonly max: number;
	/** pointerdown handler for the divider. */
	start: (e: PointerEvent) => void;
	/** keydown handler for the divider, so it isn't mouse-only. */
	nudge: (e: KeyboardEvent) => void;
}

export interface ResizablePaneOptions {
	/** localStorage key; one per pane, e.g. 'galaxy:chat-list-width'. */
	key: string;
	min: number;
	max: number;
	initial: number;
	/**
	 * Which side of the handle the pane is on. 'left' is the original and the
	 * default — a list with the divider to its right, so dragging right widens
	 * it. A pane anchored 'right' sits after its handle, and the same drag has
	 * to mean the opposite thing.
	 *
	 * Cortex's panel is on the right and got this wrong: it widened when you
	 * dragged toward it, which is backwards from every other handle in the app.
	 */
	anchor?: 'left' | 'right';
	/**
	 * Injected in tests. Defaults to localStorage when there is one — every page
	 * using this is client-rendered, so at runtime there always is.
	 */
	storage?: PaneStorage | null;
}

function defaultStorage(): PaneStorage | null {
	return typeof localStorage === 'undefined' ? null : localStorage;
}

export function createResizablePane(opts: ResizablePaneOptions): ResizablePane {
	const { key, min, max } = opts;
	// +1 when the pane is left of the handle, -1 when it is right of it. Applied
	// to the drag delta and to the arrow keys alike, so both follow the pointer.
	const direction = opts.anchor === 'right' ? -1 : 1;
	const store = opts.storage === undefined ? defaultStorage() : opts.storage;

	const clamp = (px: number) => Math.min(max, Math.max(min, Math.round(px)));

	/**
	 * A stored width is re-clamped rather than trusted: the bounds can change
	 * between releases, and a value saved under the old ones would otherwise
	 * restore a pane that can no longer be dragged back into range.
	 */
	const stored = (() => {
		try {
			const n = Number(store?.getItem(key));
			return Number.isFinite(n) && n > 0 ? n : null;
		} catch {
			return null; // storage disabled (private mode, blocked cookies)
		}
	})();

	let width = $state(clamp(stored ?? opts.initial));
	let dragging = $state(false);

	const remember = () => {
		try {
			store?.setItem(key, String(width));
		} catch {
			/* storage disabled — the drag still worked, it just won't be remembered */
		}
	};

	function start(e: PointerEvent) {
		e.preventDefault();
		dragging = true;
		const handle = e.currentTarget as HTMLElement;
		// Pointer capture keeps the drag alive over the content and the composer,
		// which would otherwise swallow the move events.
		handle.setPointerCapture(e.pointerId);
		const startX = e.clientX;
		const startWidth = width;

		const move = (ev: PointerEvent) =>
			(width = clamp(startWidth + (ev.clientX - startX) * direction));
		const up = () => {
			dragging = false;
			handle.releasePointerCapture(e.pointerId);
			handle.removeEventListener('pointermove', move);
			handle.removeEventListener('pointerup', up);
			remember();
		};
		handle.addEventListener('pointermove', move);
		handle.addEventListener('pointerup', up);
	}

	function nudge(e: KeyboardEvent) {
		const step = e.shiftKey ? 40 : 10;
		if (e.key === 'ArrowLeft') width = clamp(width - step * direction);
		else if (e.key === 'ArrowRight') width = clamp(width + step * direction);
		else return;
		e.preventDefault();
		remember();
	}

	return {
		get width() {
			return width;
		},
		get dragging() {
			return dragging;
		},
		min,
		max,
		start,
		nudge
	};
}
