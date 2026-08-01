/**
 * Grow a textarea to fit what has been typed, up to the height its CSS
 * `max-height` allows, then let it scroll.
 *
 * The measurement is the standard one — collapse to `auto`, read `scrollHeight`
 * — because there is no way to ask an element how tall its content *would* be
 * while it is constrained to a smaller height.
 *
 * The `value` parameter is what makes this correct rather than nearly correct:
 * the composers reset their text after sending and reload a stored draft when
 * the conversation changes, neither of which fires an `input` event. Without
 * re-measuring on the value itself, the box stays tall after a send and stays
 * short when a long draft is restored.
 */
export function autoresize(node: HTMLTextAreaElement, value: string) {
	function resize(): void {
		const style = getComputedStyle(node);
		// scrollHeight is content + padding. `height` means the border box under
		// border-box sizing and the content box otherwise, so it needs adjusting
		// in opposite directions — getting this wrong leaves a permanent 1–2px
		// scrollbar in a box that looks like it fits.
		const adjust =
			style.boxSizing === 'border-box'
				? parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth)
				: -(parseFloat(style.paddingTop) + parseFloat(style.paddingBottom));

		// The cap lives in CSS so it still applies before hydration; read it back
		// rather than duplicating the number here.
		const max = parseFloat(style.maxHeight);

		node.style.height = 'auto';
		const wanted = node.scrollHeight + adjust;
		node.style.height = `${Number.isFinite(max) ? Math.min(wanted, max) : wanted}px`;
	}

	// A width change re-wraps the text, which changes the height it needs —
	// rotating a phone is the case that makes this visible.
	const onResize = () => resize();
	window.addEventListener('resize', onResize);
	node.addEventListener('input', onResize);
	resize();

	return {
		update(next: string) {
			if (next === value) return;
			value = next;
			resize();
		},
		destroy() {
			window.removeEventListener('resize', onResize);
			node.removeEventListener('input', onResize);
		}
	};
}
