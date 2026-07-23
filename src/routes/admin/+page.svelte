<script lang="ts">
	import Providers from '$lib/components/admin/Providers.svelte';
	import Models from '$lib/components/admin/Models.svelte';
	import Tasks from '$lib/components/admin/Tasks.svelte';
	import Settings from '$lib/components/admin/Settings.svelte';
	import Usage from '$lib/components/admin/Usage.svelte';

	const tabs = ['Providers', 'Models', 'Tasks', 'Settings', 'Usage'] as const;
	let active = $state<(typeof tabs)[number]>('Providers');
	let modelsRefreshKey = $state(0);
</script>

<div class="admin">
	<nav class="tabs">
		{#each tabs as tab (tab)}
			<button class:active={active === tab} onclick={() => (active = tab)}>{tab}</button>
		{/each}
	</nav>

	<div class="body">
		{#if active === 'Providers'}
			<Providers onchanged={() => modelsRefreshKey++} />
		{:else if active === 'Models'}
			<Models refreshKey={modelsRefreshKey} />
		{:else if active === 'Tasks'}
			<Tasks />
		{:else if active === 'Settings'}
			<Settings />
		{:else}
			<Usage />
		{/if}
	</div>
</div>

<style>
	.admin {
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
		font-size: 0.8rem;
		padding: 0.5rem 0.8rem;
		cursor: pointer;
	}
	.tabs button.active {
		color: var(--fg);
		border-bottom-color: var(--accent);
	}
	.body {
		max-width: 60rem;
	}
</style>
