/**
 * True when the device has a precise pointer — a mouse or trackpad — and
 * therefore a keyboard with a usable Shift-Enter.
 *
 * Pointer type rather than viewport width on purpose: a narrow desktop window
 * is still a keyboard, and a large tablet still is not. The composers use this
 * to decide whether Enter sends or inserts a newline; on a phone there is no
 * Shift-Enter, so Enter-to-send leaves no way to type a second line at all.
 *
 * Read per call rather than cached: a tablet with a keyboard attached mid-
 * session changes answer, and the check is a cheap media-query lookup.
 */
export function hasFinePointer(): boolean {
	// Falls open to "keyboard" during SSR and on anything that cannot answer:
	// keeping Enter-to-send on desktop matches the muscle memory people already
	// have, and being wrong the other way only means using the send button.
	if (typeof window === 'undefined') return true;
	return window.matchMedia?.('(pointer: fine)').matches ?? true;
}
