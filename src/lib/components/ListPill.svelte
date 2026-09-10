<script lang="ts">
	/**
	 * The way into a page's own list on a phone, and the way back out.
	 *
	 * Replaces the floating ☰ that Chat, Code and Library each grew separately.
	 * That button sat at `position: fixed; top: 0.55rem; right: 0.75rem` — inside
	 * the top bar's box and above it in the stacking order, so it permanently
	 * covered the alerts bell, the budget figure and the username at the right
	 * end of a strip that scrolls sideways. It also rendered about 29x26px, and
	 * said nothing about what it opened.
	 *
	 * This is in flow, labelled, counted, and sized from --tap. It renders the
	 * scrim as well: the drawer is dismissed by tapping beside it, which the ☰
	 * never offered — the uncovered strip of page looked like a dismiss target
	 * and was not.
	 */
	import { isDismissSwipe, registerPageList, type Point } from '$lib/list-sheet.svelte';

	interface Props {
		/** Bound to the page's own listOpen, which also drives the aside. */
		open: boolean;
		/** What is in the list, as a word: "Chats", "Sessions", "Documents". */
		label: string;
		/** How many, when the page knows. Omitted rather than shown as zero. */
		count?: number;
	}
	let { open = $bindable(), label, count }: Props = $props();

	$effect(() => registerPageList(() => (open = !open)));

	let from: Point | null = null;

	function onpointerdown(e: PointerEvent) {
		from = { x: e.clientX, y: e.clientY };
	}

	function onpointermove(e: PointerEvent) {
		if (!from) return;
		if (!isDismissSwipe(from, { x: e.clientX, y: e.clientY })) return;
		from = null;
		open = false;
	}
</script>

<svelte:window
	onkeydown={(e) => {
		if (e.key === 'Escape' && open) open = false;
	}}
/>

<button
	class="list-pill"
	aria-expanded={open}
	aria-label={`${open ? 'Hide' : 'Show'} ${label.toLowerCase()}`}
	onclick={() => (open = !open)}
>
	<span class="glyph" aria-hidden="true">☰</span>
	<span class="what">{label}</span>
	{#if count !== undefined}<span class="count num">{count}</span>{/if}
</button>

{#if open}
	<!-- Not a button: it is a dismiss surface, and Escape and the pill are the
	     ways in that a keyboard or a screen reader should be offered. -->
	<div
		class="list-scrim"
		role="presentation"
		onclick={() => (open = false)}
		{onpointerdown}
		{onpointermove}
		onpointerup={() => (from = null)}
		onpointercancel={() => (from = null)}
	></div>
{/if}

<style>
	/* In flow, and only on the layout that has no room for the list beside the
	   page. Above that width the list is a column and needs no way in. */
	.list-pill {
		display: none;
	}
	.list-scrim {
		display: none;
	}

	@media (max-width: 720px) {
		.list-pill {
			display: inline-flex;
			align-items: center;
			gap: 0.45rem;
			min-height: var(--tap);
			padding: 0 0.7rem;
			background: var(--bg-pane);
			border: 1px solid var(--control-border);
			color: var(--fg);
			font-family: inherit;
			font-size: var(--text-md);
			cursor: pointer;
		}
		.list-pill:focus-visible {
			outline: 2px solid var(--accent);
			outline-offset: 2px;
		}
		.glyph {
			color: var(--fg-dim);
		}
		.count {
			color: var(--fg-dim);
			font-size: var(--text-sm);
		}
		.list-scrim {
			display: block;
			position: fixed;
			inset: 0;
			/* Under the drawer, over the page. Tapping it is the dismiss the ☰
			   never had. */
			z-index: calc(var(--z-drawer) - 1);
		}
	}
</style>
