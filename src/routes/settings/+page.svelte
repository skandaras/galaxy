<script lang="ts">
	import Theme from '$lib/components/settings/Theme.svelte';
	import Boards from '$lib/components/settings/Boards.svelte';
	import Cortex from '$lib/components/settings/Cortex.svelte';
	import Notifications from '$lib/components/settings/Notifications.svelte';
	import Alignment from '$lib/components/settings/Alignment.svelte';
	import { page } from '$app/state';
	import { tabFromUrl } from '$lib/url-tab';
	import Tabs from '$lib/components/Tabs.svelte';

	const tabs = ['Theme', 'Boards', 'Cortex', 'Notifications', 'Alignment'] as const;
	// In the URL rather than in $state, so Back steps through tabs, a tab can
	// be linked to, and the phone's More sheet can point at one.
	const active = $derived(tabFromUrl(page.url.searchParams, tabs));
</script>

<div class="settings">
	<Tabs {tabs} label="Settings" />

	<div class="body">
		{#if active === 'Theme'}
			<Theme />
		{:else if active === 'Boards'}
			<Boards />
		{:else if active === 'Cortex'}
			<Cortex />
		{:else if active === 'Notifications'}
			<Notifications />
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
	@media (max-width: 720px) {
		.settings {
			padding: 0.75rem 0.85rem;
		}
	}
</style>
