<script lang="ts">
	import Providers from '$lib/components/admin/Providers.svelte';
	import Models from '$lib/components/admin/Models.svelte';
	import Tasks from '$lib/components/admin/Tasks.svelte';
	import Skills from '$lib/components/admin/Skills.svelte';
	import Tools from '$lib/components/admin/Tools.svelte';
	import Memory from '$lib/components/admin/Memory.svelte';
	import Users from '$lib/components/admin/Users.svelte';
	import Boards from '$lib/components/admin/Boards.svelte';
	import Ux from '$lib/components/admin/Ux.svelte';
	import Cortex from '$lib/components/admin/Cortex.svelte';
	import Settings from '$lib/components/admin/Settings.svelte';
	import Usage from '$lib/components/admin/Usage.svelte';
	import { page } from '$app/state';
	import { tabFromUrl } from '$lib/url-tab';
	import Tabs from '$lib/components/Tabs.svelte';

	const tabs = [
		'Users',
		'Providers',
		'Models',
		'Tasks',
		'Tools',
		'Skills',
		'Memory',
		'Boards',
		'Cortex',
		'UX',
		'Settings',
		'Usage'
	] as const;
	// In the URL rather than in $state, so Back steps through tabs, a tab can
	// be linked to, and the phone's More sheet can point at one.
	const active = $derived(tabFromUrl(page.url.searchParams, tabs));
	let modelsRefreshKey = $state(0);
</script>

<div class="admin">
	<Tabs {tabs} label="Admin" />

	<div class="body">
		{#if active === 'Users'}
			<Users />
		{:else if active === 'Providers'}
			<Providers onchanged={() => modelsRefreshKey++} />
		{:else if active === 'Models'}
			<Models refreshKey={modelsRefreshKey} />
		{:else if active === 'Tasks'}
			<Tasks />
		{:else if active === 'Tools'}
			<Tools />
		{:else if active === 'Skills'}
			<Skills />
		{:else if active === 'Memory'}
			<Memory />
		{:else if active === 'Cortex'}
			<Cortex />
		{:else if active === 'Boards'}
			<Boards />
		{:else if active === 'UX'}
			<Ux />
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
	.body {
		max-width: 60rem;
	}

	@media (max-width: 720px) {
		.admin {
			padding: 0.75rem 0.85rem;
		}
		.admin :global(.tabs button) {
			padding: 0.45rem 0.55rem;
			font-size: var(--text-base);
		}
		/* Admin tab bodies are rendered by child components, so their tables
		   need reaching into: let each section scroll horizontally rather than
		   crushing columns or blowing out the page width. */
		.body :global(section) {
			overflow-x: auto;
			-webkit-overflow-scrolling: touch;
		}
		.body :global(table) {
			min-width: 32rem;
		}
		.body :global(.grid) {
			grid-template-columns: 1fr;
		}
	}
</style>
