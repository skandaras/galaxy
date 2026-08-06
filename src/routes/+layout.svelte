<script lang="ts">
	import { page } from '$app/state';
	import Observatory from '$lib/components/Observatory.svelte';
	import BudgetBar from '$lib/components/BudgetBar.svelte';
	import GalaxyBackdrop from '$lib/components/GalaxyBackdrop.svelte';
	import { themeCss } from '$lib/theme';

	let { data, children } = $props();

	const links = $derived([
		{ href: '/chat', label: 'Chat' },
		// Coding is a per-user grant, because it pushes with a shared GitHub
		// token; the API refuses it either way, this just stops offering it.
		...(data.user?.canCode ? [{ href: '/code', label: 'Code' }] : []),
		{ href: '/library', label: 'Library' },
		{ href: '/settings', label: 'Settings' },
		...(data.user?.isAdmin ? [{ href: '/admin', label: 'Admin' }] : [])
	]);
</script>

<svelte:head>
	{@html `<style id="galaxy-theme">${themeCss(data.theme)}
	button, input, select, textarea { border-radius: var(--radius); }</style>`}
</svelte:head>

{#if data.theme.galaxyBg}
	<GalaxyBackdrop animate={data.theme.galaxyAnimate} />
{/if}

<div class="shell">
	<aside class="pane">
		<div class="brand">✦ GALAXY</div>
		<nav class="nav">
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
</div>

<style>
	:global(body) {
		margin: 0;
		background: var(--bg);
		color: var(--fg);
		font-family: var(--font-mono);
	}
	.shell {
		display: flex;
		height: 100vh;
		overflow: hidden;
		position: relative;
		z-index: 1;
	}
	.pane {
		width: 230px;
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
		color: var(--accent);
		letter-spacing: 0.35em;
		font-size: 0.9rem;
		margin-bottom: 2rem;
	}
	.nav {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.nav-item {
		color: var(--fg-dim);
		font-size: 0.85rem;
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
		font-size: 0.75rem;
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
		.shell {
			flex-direction: column;
			height: auto;
			min-height: 100vh;
			overflow: visible;
		}
		.main {
			overflow: visible;
		}
		.pane {
			width: 100%;
			flex-direction: row;
			align-items: center;
			border-right: none;
			border-bottom: 1px solid var(--border);
			/* Sits under the status bar when installed to a phone home screen. */
			padding: max(0.5rem, env(safe-area-inset-top)) 0.75rem 0.5rem;
			overflow-x: auto;
			overflow-y: visible;
			position: sticky;
			top: 0;
			z-index: 10;
		}
		.brand {
			margin-bottom: 0;
			margin-right: 0.9rem;
			font-size: 0.75rem;
			letter-spacing: 0.2em;
			flex-shrink: 0;
		}
		.nav {
			flex-direction: row;
			gap: 0.15rem;
		}
		.nav-item {
			font-size: 0.75rem;
			padding: 0.3rem 0.45rem;
			white-space: nowrap;
		}
		/* The docked feed needs vertical room it doesn't have in a top bar;
		   the full view at /observatory stays available. */
		.obs-dock {
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
