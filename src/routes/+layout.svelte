<script lang="ts">
	import { page } from '$app/state';
	import Observatory from '$lib/components/Observatory.svelte';
	import BudgetBar from '$lib/components/BudgetBar.svelte';
	import NotificationBell from '$lib/components/NotificationBell.svelte';
	import GalaxyBackdrop from '$lib/components/GalaxyBackdrop.svelte';
	import BottomNav from '$lib/components/BottomNav.svelte';
	import { themeCss } from '$lib/theme';
	import { attachViewport } from '$lib/viewport.svelte';

	let { data, children } = $props();

	const links = $derived([
		{ href: '/chat', label: 'Chat' },
		// Coding is a per-user grant, because it pushes with a shared GitHub
		// token; the API refuses it either way, this just stops offering it.
		...(data.user?.canCode ? [{ href: '/code', label: 'Code' }] : []),
		{ href: '/boards', label: 'Boards' },
		{ href: '/library', label: 'Library' },
		{ href: '/cortex', label: 'Cortex' },
		// A private feature, off by default and turned on per person in Settings.
		...(data.alignmentEnabled ? [{ href: '/alignment', label: 'Alignment' }] : []),
		{ href: '/settings', label: 'Settings' },
		...(data.user?.isAdmin ? [{ href: '/admin', label: 'Admin' }] : [])
	]);

	// The rail is unchanged; the bar gets one destination the rail never had.
	// /observatory is linked only from the docked feed's "open full view", and
	// that dock is display:none on a phone — so the full view has been
	// unreachable there, which docs/MOBILE.md claims it is not.
	const barLinks = $derived([...links, { href: '/observatory', label: 'Observatory' }]);

	$effect(() =>
		attachViewport(window, (name, value) =>
			document.documentElement.style.setProperty(name, value)
		)
	);
</script>

<svelte:head>
	<!-- Follows the theme rather than app.html's fixed #05060f, which is what
	     colours the browser and status bar around an installed app. The manifest
	     keeps the fixed value on purpose: it is read at install time, when there
	     is no signed-in person to have a theme, and by Bubblewrap when it builds
	     the Android package. -->
	<meta name="theme-color" content={data.theme.bg} />
	<!-- touch-action is here rather than on each control because the failure it
	     fixes is not any one component's. iOS keeps double-tap-to-zoom on a
	     width=device-width page — Chrome drops it, Safari does not — and the
	     gesture recogniser can swallow the second tap of a quick pair on the same
	     element. The tab bar's "tap the tab you are already on" *is* that pair, so
	     whether it worked came down to how fast the thumb was. -->
	{@html `<style id="galaxy-theme">${themeCss(data.theme)}
	button, input, select, textarea { border-radius: var(--radius); }
	button, a, input, select, textarea { touch-action: manipulation; }</style>`}
</svelte:head>

{#if data.theme.galaxyBg}
	<GalaxyBackdrop animate={data.theme.galaxyAnimate} />
{/if}

<div class="shell">
	<aside class="pane">
		<div class="brand">✦ GALAXY</div>
		<nav class="nav" aria-label="Sections">
			{#each links as link (link.href)}
				<a
					class="nav-item"
					class:active={page.url.pathname.startsWith(link.href)}
					href={link.href}>{link.label}</a
				>
			{/each}
		</nav>
		<div class="pane-bottom">
			{#if data.user}
				<div class="bell-dock"><NotificationBell /></div>
				<div class="obs-dock"><Observatory /></div>
				<div class="budget-dock"><BudgetBar /></div>
			{/if}
			<div class="pane-footer">
				<span class="env-badge">{data.galaxyEnv}</span>
				{#if data.user}<span class="user">{data.user.username}</span>{/if}
			</div>
		</div>
	</aside>
	<main class="main">
		{@render children()}
	</main>
	<BottomNav links={barLinks} />
</div>

<style>
	:global(body) {
		margin: 0;
		background: var(--bg);
		color: var(--fg);
		font-family: var(--font-ui);
	}

	/* The drawer a page's own list becomes on a phone. Global and declared once
	   here, because Chat, Code and Library each wrote this block separately and
	   identically — right down to the transition duration — and three scoped
	   copies is how the fourth page gets it subtly wrong.

	   The insets differed (25% vs 30%) for no reason anyone recorded, so this
	   picks one. What the copies all lacked: overscroll-behavior, so flicking
	   the list to its end scrolled the page behind it; and a reduced-motion
	   escape for the slide. */
	/* The strip a page puts above its content on a phone: the way into its
	   list, and whatever else it cannot leave inside that list. Hidden above the
	   breakpoint, where the list is a column and needs no way in. */
	:global(.page-actions) {
		display: none;
	}
	@media (max-width: 720px) {
		:global(.page-actions) {
			display: flex;
			align-items: center;
			gap: 0.4rem;
			padding: 0.5rem 0.75rem 0;
		}
		:global(.page-list) {
			position: fixed;
			/* This used to say width:auto, with a comment claiming it beat the
			   inline --list-width the resize handle writes. It never did: the pages
			   write a custom property, not a width, and their own
			   `.chat-list { width: … }` compiles to a scoped two-class selector that
			   outranks this one-class global whatever the media query says. So the
			   sheet opened at the *desktop* pane width — 340px of a 390px screen,
			   and all of a 320px one, which left no scrim to dismiss it with and
			   covered the pill too. The width now lives behind (min-width: 721px) in
			   each page, so there is nothing here to beat.
			   The bottom inset clears the bar rather than being 0: the drawer sits
			   below the bar in the stacking order, so a list running to the bottom
			   of the screen had its last rows permanently underneath it. */
			inset: var(--chrome-top) 25% var(--above-bar) 0;
			background: var(--bg-pane);
			z-index: var(--z-drawer);
			transform: translateX(-100%);
			transition: transform 0.2s ease;
			overscroll-behavior: contain;
		}
		:global(.page-list.open) {
			transform: translateX(0);
		}
	}
	@media (max-width: 720px) and (prefers-reduced-motion: reduce) {
		:global(.page-list) {
			transition: none;
		}
	}
	:global(:root) {
		/* What the fixed chrome occupies at each edge, composed here because the
		   sizes come from the theme and the breakpoint is the layout's. Every
		   bottom-anchored thing reads one of these rather than measuring the bar
		   or, as the alerts panel did, hard-coding 4rem and hoping. */
		--chrome-top: 0px;
		--chrome-bottom: env(safe-area-inset-bottom, 0px);
		/* Where a position:fixed thing has to sit to clear the bar. Two tokens
		   rather than one because they answer different questions: anything
		   *inside* the shell measures against --chrome-bottom, since the shell
		   has already been shortened by the keyboard; anything fixed to the
		   viewport has the keyboard underneath it as well. Everything that got
		   this wrong got it wrong by writing the sum out by hand. */
		--above-bar: calc(var(--chrome-bottom) + var(--kbd));
	}
	.shell {
		display: flex;
		/* dvh, not vh: on iOS 100vh is the largest viewport, so anything pinned
		   to the bottom of it hides under the URL bar until you scroll. Headless
		   Chromium resolves the two identically, so no test here can tell them
		   apart and this comment is the only record.
		   Minus --kbd because dvh does not account for the software keyboard on
		   either platform that matters. attachViewport() had been measuring the
		   inset and publishing it since the bar arrived, and nothing in the tree
		   read it — so the composer sat behind the keyboard for the whole of that
		   time, which is the one thing docs/MOBILE.md promises it does not do. The
		   number is 0 wherever the layout viewport shrank on its own, so this is
		   one rule for both. */
		height: calc(100dvh - var(--kbd));
		overflow: hidden;
		position: relative;
		z-index: var(--z-base);
		padding-bottom: var(--chrome-bottom);
		box-sizing: border-box;
	}
	.pane {
		width: 260px;
		flex-shrink: 0;
		background: var(--bg-pane);
		border-right: 1px solid var(--border);
		display: flex;
		flex-direction: column;
		padding: 1rem;
		box-sizing: border-box;
		overflow-y: auto;
	}
	.brand {
		/* The wordmark's letter-spacing was drawn against a monospace face and
		   reads as loose in a proportional one. */
		font-family: var(--font-mono);
		color: var(--accent);
		letter-spacing: 0.35em;
		font-size: var(--text-lg);
		margin-bottom: 2rem;
	}
	.nav {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.nav-item {
		color: var(--fg-dim);
		font-size: var(--text-lg);
		padding: 0.4rem 0.6rem;
		border-radius: 4px;
		text-decoration: none;
	}
	.nav-item:hover {
		color: var(--fg);
	}
	.nav-item.active {
		color: var(--fg);
		background: var(--border);
	}
	.bell-dock {
		border-top: 1px solid var(--border);
		padding-top: 0.4rem;
	}
	.pane-bottom {
		margin-top: auto;
	}
	.budget-dock {
		margin-top: 0.5rem;
	}
	.pane-footer {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		font-size: var(--text-base);
		margin-top: 0.6rem;
	}
	.env-badge {
		color: var(--bg);
		background: var(--accent);
		padding: 0.1rem 0.5rem;
		border-radius: 3px;
		text-transform: uppercase;
		letter-spacing: 0.1em;
	}
	.user {
		color: var(--fg-dim);
	}
	.main {
		flex: 1;
		display: flex;
		min-width: 0;
		min-height: 0;
		overflow: hidden;
	}
	@media (max-width: 720px) {
		:global(:root) {
			--chrome-top: calc(var(--strip-h) + env(safe-area-inset-top, 0px));
			--chrome-bottom: calc(var(--tabbar-h) + env(safe-area-inset-bottom, 0px));
		}
		/* Was height:auto with overflow:visible, which made the document the
		   thing that scrolled: the composer sat at the end of it, so typing meant
		   scrolling past the whole conversation, and every streamed token pushed
		   the input further away. Now the shell is one screen and the thread is
		   the only scroller. */
		.shell {
			flex-direction: column;
			padding-top: var(--chrome-top);
		}
		.main {
			min-height: 0;
		}
		.pane {
			position: fixed;
			inset: 0 0 auto 0;
			width: auto;
			height: var(--chrome-top);
			flex-direction: row;
			align-items: center;
			border-right: none;
			border-bottom: 1px solid var(--border);
			/* Clears the notch when installed to a phone home screen. */
			padding: env(safe-area-inset-top, 0px) 0.75rem 0;
			box-sizing: border-box;
			/* Was overflow-x: auto, for a strip of links that had to scroll
			   sideways. The links are in the tab bar now, and what is left —
			   wordmark, bell, budget, badge, name — fits without scrolling. */
			overflow: hidden;
			z-index: var(--z-chrome);
		}
		/* Navigation moved to the thumb. This keeps the same markup so the rail
		   is still one element at both widths, which the browser smoke waits on
		   by name for every page it visits. */
		.nav {
			display: none;
		}
		.brand {
			margin-bottom: 0;
			margin-right: 0.9rem;
			font-size: var(--text-base);
			letter-spacing: 0.2em;
			flex-shrink: 0;
		}
		.nav {
			flex-direction: row;
			gap: 0.15rem;
		}
		.nav-item {
			font-size: var(--text-base);
			padding: 0.3rem 0.45rem;
			white-space: nowrap;
		}
		/* The docked feed needs vertical room it doesn't have in a top bar;
		   the full view at /observatory stays available. */
		.obs-dock {
			display: none;
		}
		/* In the top bar the bell is just the glyph and its count — the word
		   "Alerts" and the divider are desktop-sidebar furniture. */
		.bell-dock {
			border-top: none;
			padding-top: 0;
		}
		.bell-dock :global(.label) {
			display: none;
		}
		/* Same reasoning as the feed above: the top bar has no vertical room, so
		   the bar drops and only the figure stays. */
		.budget-dock {
			margin-top: 0;
		}
		.budget-dock :global(.track) {
			display: none;
		}
		.pane-bottom {
			margin-top: 0;
			margin-left: auto;
			display: flex;
			align-items: center;
			gap: 0.6rem;
		}
		.pane-footer {
			margin-top: 0;
			flex-shrink: 0;
		}
	}
</style>
