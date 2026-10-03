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
	import AdminNav from '$lib/components/admin/AdminNav.svelte';
	import { page } from '$app/state';
	import { tabFromUrl } from '$lib/url-tab';
	import { ADMIN_SECTIONS, ADMIN_SECTION_LABELS } from '$lib/admin-sections';

	// An unknown section, including the old tab names, lands on the first.
	const active = $derived(tabFromUrl(page.url.searchParams, ADMIN_SECTION_LABELS));
	const tasks = $derived(ADMIN_SECTIONS.find((s) => s.label === active)?.tasks ?? []);
	let modelsRefreshKey = $state(0);
</script>

<div class="admin">
	<AdminNav {active} />

	<!-- Each feature's section holds everything that configures it: its own
	     settings, its task prompts and models, and how long its history is kept.
	     These were spread across Tasks, Tools, Settings and the feature's own tab. -->
	<div class="body">
		<h1>{active}</h1>
		{#if active === 'Users'}
			<Users />
		{:else if active === 'Providers'}
			<Providers onchanged={() => modelsRefreshKey++} />
		{:else if active === 'Models'}
			<Models refreshKey={modelsRefreshKey} />
		{:else if active === 'Tools'}
			<Tools />
		{:else if active === 'Language'}
			<Settings cards={['language']} />
		{:else if active === 'General tasks'}
			<Tasks only={tasks} intro />
		{:else if active === 'Research'}
			<Settings cards={['websearch', 'research', 'fetch']} />
			<Tasks only={tasks} />
		{:else if active === 'Coding'}
			<Settings cards={['coding', 'github']} />
			<Tasks only={tasks} />
		{:else if active === 'Memory and skills'}
			<Memory />
			<Skills />
			<Tasks only={tasks} />
		{:else if active === 'Boards'}
			<Boards />
			<Tasks only={tasks} />
		{:else if active === 'Cortex'}
			<Cortex />
			<Tasks only={tasks} />
			<Settings cards={['retention']} retentionFields={['cortexChangeDays']} />
		{:else if active === 'Ivory Tower'}
			<Settings cards={['ivory']} />
			<Tasks only={tasks} />
		{:else if active === 'Alignment'}
			<Tasks only={tasks} />
		{:else if active === 'UX audit'}
			<Ux />
			<Tasks only={tasks} />
			<Settings cards={['retention']} retentionFields={['uxIdeaDays']} />
		{:else if active === 'Spend'}
			<Settings cards={['budget', 'retention']} retentionFields={['usageDays']} />
			<Usage />
		{:else if active === 'Conversations'}
			<Settings cards={['compaction']} />
		{:else}
			<Settings cards={['deploy', 'push', 'retention']} retentionFields={['eventDays']} />
		{/if}
	</div>
</div>

<style>
	.admin {
		flex: 1;
		display: flex;
		gap: 1.5rem;
		min-width: 0;
		padding: 1rem 1.25rem;
		overflow-y: auto;
	}
	.body {
		flex: 1;
		min-width: 0;
		max-width: 60rem;
	}
	h1 {
		margin: 0 0 1rem;
		font-size: var(--text-lg);
		letter-spacing: 0.3em;
		color: var(--heading);
	}

	@media (max-width: 720px) {
		.admin {
			flex-direction: column;
			gap: 0;
			padding: 0.75rem 0.85rem;
		}
		/* Admin section bodies are rendered by child components, so their tables
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
