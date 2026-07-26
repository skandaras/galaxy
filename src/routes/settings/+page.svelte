<script lang="ts">
	import Theme from '$lib/components/settings/Theme.svelte';
	import Memory from '$lib/components/settings/Memory.svelte';

	const tabs = ['Theme', 'Memory'] as const;
	let active = $state<(typeof tabs)[number]>('Theme');
</script>

<div class="settings">
	<nav class="tabs">
		{#each tabs as tab (tab)}
			<button class:active={active === tab} onclick={() => (active = tab)}>{tab}</button>
		{/each}
	</nav>

	<div class="body">
		{#if active === 'Theme'}
			<Theme />
		{:else}
			<Memory />
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
		font-size: 0.8rem;
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
