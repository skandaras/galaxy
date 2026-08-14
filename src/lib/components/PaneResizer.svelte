<script lang="ts">
	import type { ResizablePane } from '$lib/resizable-pane.svelte';

	let { pane, label }: { pane: ResizablePane; label: string } = $props();
</script>

<!-- A slider rather than a separator role: this is a value the user sets, and
     the arrow keys move it, which is exactly what a slider announces. -->
<div
	class="resizer"
	class:dragging={pane.dragging}
	role="slider"
	aria-orientation="vertical"
	aria-label={label}
	aria-valuenow={pane.width}
	aria-valuemin={pane.min}
	aria-valuemax={pane.max}
	tabindex="0"
	onpointerdown={pane.start}
	onkeydown={pane.nudge}
></div>

<style>
	/* The divider doubles as the drag handle: a 1px border with a wider
	   invisible grab area, so it is hittable without looking like a gutter. */
	.resizer {
		flex: 0 0 5px;
		margin-right: -4px;
		background: var(--border);
		background-clip: content-box;
		border-right: 4px solid transparent;
		cursor: col-resize;
		touch-action: none;
	}
	.resizer:hover,
	.resizer:focus-visible,
	.resizer.dragging {
		background-color: var(--accent);
		outline: none;
	}
	/* On a phone the list is a slide-over sheet, not a column — there is nothing
	   to drag, and the handle would sit on top of the content. */
	@media (max-width: 720px) {
		.resizer {
			display: none;
		}
	}
</style>
