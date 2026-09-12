<script lang="ts">
	/**
	 * Navigation where the thumb already is.
	 *
	 * The rail used to lie down into a sticky strip that scrolled sideways, which
	 * meant every destination past the fourth was off-screen and reached by
	 * dragging a bar at the top of a phone — the hardest place on the screen to
	 * reach and the easiest to cover, which is exactly what the page-level ☰ did.
	 *
	 * Four tabs and More. Which four is decided in $lib/mobile-nav, by a fixed
	 * priority rather than by position, so the bar does not reshuffle the day
	 * someone is granted Code or made an admin.
	 */
	import { page } from '$app/state';
	import { MORE_GLYPH, navGlyph, splitNav, type NavLink } from '$lib/mobile-nav';
	import { pageList } from '$lib/list-sheet.svelte';

	interface Props {
		links: NavLink[];
	}
	let { links }: Props = $props();

	const buckets = $derived(splitNav(links));
	let moreOpen = $state(false);

	const isActive = (href: string) => page.url.pathname.startsWith(href);
	const moreActive = $derived(buckets.more.some((l) => isActive(l.href)));

	function onTab(e: MouseEvent, href: string) {
		moreOpen = false;
		// Tapping the tab you are already on opens that page's own list — the
		// second way in, for a thumb that is already down here. Pages without a
		// list register nothing, and the tap stays an ordinary navigation.
		if (!isActive(href) || !pageList.present) return;
		e.preventDefault();
		pageList.toggle();
	}
</script>

<svelte:window
	onkeydown={(e) => {
		if (e.key === 'Escape' && moreOpen) moreOpen = false;
	}}
/>

<nav class="tabbar" aria-label="Main">
	{#each buckets.tabs as tab (tab.href)}
		<a
			class="tab"
			class:on={isActive(tab.href)}
			aria-current={isActive(tab.href) ? 'page' : undefined}
			href={tab.href}
			onclick={(e) => onTab(e, tab.href)}
		>
			<span class="glyph" aria-hidden="true">{navGlyph(tab.href)}</span>
			<span class="label">{tab.label}</span>
		</a>
	{/each}

	{#if buckets.more.length}
		<button
			class="tab more"
			class:on={moreOpen || moreActive}
			aria-expanded={moreOpen}
			aria-haspopup="menu"
			onclick={() => (moreOpen = !moreOpen)}
		>
			<span class="glyph" aria-hidden="true">{MORE_GLYPH}</span>
			<span class="label">More</span>
		</button>
	{/if}
</nav>

{#if moreOpen}
	<div class="more-scrim" role="presentation" onclick={() => (moreOpen = false)}></div>
	<div class="more-sheet" role="menu" aria-label="More sections">
		{#each buckets.more as link (link.href)}
			<a
				class="more-item"
				class:on={isActive(link.href)}
				role="menuitem"
				href={link.href}
				onclick={() => (moreOpen = false)}
			>
				<span class="glyph" aria-hidden="true">{navGlyph(link.href)}</span>
				{link.label}
			</a>
		{/each}
	</div>
{/if}

<style>
	/* Structure is the width's business: above this the rail is a column and
	   there is nothing to reach for. Size is the pointer's business, further
	   down — a narrow desktop window gets this bar, but not thumb-sized. */
	.tabbar,
	.more-scrim,
	.more-sheet {
		display: none;
	}

	@media (max-width: 720px) {
		.tabbar {
			display: flex;
			position: fixed;
			/* Rides on top of the keyboard rather than behind it. Fixed to the
			   layout viewport, which neither platform shrinks for a keyboard, so
			   without the offset the bar — and the composer sitting on it — were
			   both under the thing being typed on. --kbd is 0 when it is shut. */
			inset: auto 0 var(--kbd) 0;
			height: var(--chrome-bottom);
			/* The bar is the bottom-most element on the screen, so it is the one
			   that pays the home-indicator inset. Nothing above it does — see the
			   composers, which used to. */
			padding-bottom: env(safe-area-inset-bottom, 0px);
			box-sizing: border-box;
			background: var(--bg-pane);
			border-top: 1px solid var(--border);
			/* Same layer as the top strip and later in source order, which is what
			   keeps the bar above anything docked up there. */
			z-index: var(--z-chrome);
		}
		.tab {
			flex: 1;
			min-width: 0;
			display: flex;
			flex-direction: column;
			align-items: center;
			justify-content: center;
			gap: 0.1rem;
			background: none;
			border: 0;
			padding: 0;
			color: var(--fg-dim);
			font-family: inherit;
			text-decoration: none;
			cursor: pointer;
		}
		.tab:focus-visible {
			outline: 2px solid var(--accent);
			outline-offset: -2px;
		}
		.tab.on {
			color: var(--accent);
		}
		.glyph {
			font-size: var(--text-lg);
			line-height: 1;
		}
		.label {
			font-size: var(--text-xs);
			line-height: 1;
		}

		.more-scrim {
			display: block;
			position: fixed;
			/* Stops above the bar. It was inset:0 at a layer over --z-chrome, which
			   killed the bar the moment the sheet opened: the first tap on any tab
			   only dismissed the sheet, so every destination needed two. A scrim
			   over the control that opened it is never right — and the sheet is
			   anchored to that bar, so it is the one thing that must stay live. */
			inset: 0 0 var(--above-bar) 0;
			z-index: var(--z-scrim);
		}
		.more-sheet {
			display: flex;
			flex-direction: column;
			position: fixed;
			inset: auto 0 var(--above-bar) 0;
			z-index: var(--z-popover);
			background: var(--bg-pane);
			border-top: 1px solid var(--border);
			box-shadow: 0 -8px 24px rgb(0 0 0 / 0.35);
		}
		.more-item {
			display: flex;
			align-items: center;
			gap: 0.7rem;
			min-height: var(--tap);
			padding: 0 1rem;
			color: var(--fg);
			font-size: var(--text-md);
			text-decoration: none;
		}
		.more-item + .more-item {
			border-top: 1px solid var(--border);
		}
		.more-item.on {
			color: var(--accent);
		}
		.more-item:focus-visible {
			outline: 2px solid var(--accent);
			outline-offset: -2px;
		}
	}

	/* A finger needs the room; a mouse in a narrow window does not. */
	@media (max-width: 720px) and (pointer: coarse) {
		.glyph {
			font-size: var(--text-xl);
		}
		.label {
			font-size: var(--text-sm);
		}
	}
</style>
