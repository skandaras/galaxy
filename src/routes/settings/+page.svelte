<script lang="ts">
	import Theme from '$lib/components/settings/Theme.svelte';
	import Memory from '$lib/components/settings/Memory.svelte';
	import Boards from '$lib/components/settings/Boards.svelte';
	import Cortex from '$lib/components/settings/Cortex.svelte';
	import Notifications from '$lib/components/settings/Notifications.svelte';
	import Alignment from '$lib/components/settings/Alignment.svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { tabFromUrl, tabUrl } from '$lib/url-tab';

	const tabs = ['Theme', 'Boards', 'Cortex', 'Notifications', 'Memory', 'Alignment'] as const;
	// In the URL rather than in $state, so Back steps through tabs, a tab can
	// be linked to, and the phone's More sheet can point at one.
	const active = $derived(tabFromUrl(page.url.searchParams, tabs));
	const show = (tab: (typeof tabs)[number]) =>
		void goto(tabUrl(page.url.pathname, tab, tabs), { keepFocus: true, noScroll: true });
</script>

<div class="settings">
	<nav class="tabs">
		{#each tabs as tab (tab)}
			<button class:active={active === tab} onclick={() => show(tab)}>{tab}</button>
		{/each}
	</nav>

	<div class="body">
		{#if active === 'Theme'}
			<Theme />
		{:else if active === 'Boards'}
			<Boards />
		{:else if active === 'Cortex'}
			<Cortex />
		{:else if active === 'Notifications'}
			<Notifications />
		{:else if active === 'Memory'}
			<Memory />
		{:else}
			<Alignment />
		{/if}
	</div>
</div>

<style>
	.settings {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-width: 0;
		padding: 1rem 1.25rem;
		overflow-y: auto;
	}
	.tabs {
		display: flex;
		gap: 0.3rem;
		border-bottom: 1px solid var(--border);
		margin-bottom: 1rem;
		flex-wrap: wrap;
	}
	.tabs button {
		background: none;
		border: none;
		border-bottom: 2px solid transparent;
		color: var(--fg-dim);
		font-family: inherit;
		font-size: var(--text-md);
		padding: 0.5rem 0.8rem;
		cursor: pointer;
	}
	.tabs button.active {
		color: var(--fg);
		border-bottom-color: var(--accent);
	}
	@media (max-width: 720px) {
		.settings {
			padding: 0.75rem 0.85rem;
		}
	}
</style>
