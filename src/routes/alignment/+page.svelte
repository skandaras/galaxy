<script lang="ts">
	import Standing from '$lib/components/alignment/Standing.svelte';
	import Journal from '$lib/components/alignment/Journal.svelte';
	import Constitution from '$lib/components/alignment/Constitution.svelte';
	import RubricView from '$lib/components/alignment/RubricView.svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { tabFromUrl, tabUrl } from '$lib/url-tab';

	const tabs = ['Standing', 'Journal', 'Constitution', 'Rubric'] as const;
	type Tab = (typeof tabs)[number];
	// In the URL rather than in $state, so Back steps through tabs, a tab can
	// be linked to, and the phone's More sheet can point at one.
	const active = $derived(tabFromUrl(page.url.searchParams, tabs));
	const show = (tab: Tab) =>
		void goto(tabUrl(page.url.pathname, tab, tabs), { keepFocus: true, noScroll: true });

	/**
	 * Names for the ids that come back inside a reading. The assessment stores
	 * principle and dimension ids rather than titles on purpose — a title can be
	 * reworded, and an old reading should still resolve to the thing it meant —
	 * so the lookup is assembled here and handed down.
	 */
	let principleTitles = $state<Record<string, string>>({});
	let dimensionNames = $state<Record<string, string>>({});
	let mechanismNames = $state<Record<string, string>>({});
	let hasConstitution = $state(false);
	/** Bumped after any change, so the tabs reload rather than showing stale state. */
	let revision = $state(0);

	async function loadNames() {
		const [p, r] = await Promise.all([
			fetch('/api/alignment/principles'),
			fetch('/api/alignment/rubric')
		]);
		if (p.ok) {
			const { principles } = await p.json();
			principleTitles = Object.fromEntries(
				principles.map((x: { id: string; title: string }) => [x.id, x.title])
			);
			hasConstitution = principles.some(
				(x: { status: string }) => x.status !== 'retired'
			);
		}
		if (r.ok) {
			const data = await r.json();
			dimensionNames = Object.fromEntries(
				data.dimensions.map((d: { id: string; name: string }) => [d.id, d.name])
			);
			mechanismNames = data.mechanisms;
		}
	}
	$effect(() => {
		void loadNames();
	});

	function changed() {
		revision++;
		void loadNames();
	}
</script>

<div class="alignment">
	<nav class="tabs">
		{#each tabs as tab (tab)}
			<button class:active={active === tab} onclick={() => show(tab)}>{tab}</button>
		{/each}
	</nav>

	<div class="body">
		{#key revision}
			{#if active === 'Standing'}
				<Standing onGoTo={show} />
			{:else if active === 'Journal'}
				<Journal
					{principleTitles}
					{dimensionNames}
					{mechanismNames}
					{hasConstitution}
					onChanged={changed}
				/>
			{:else if active === 'Constitution'}
				<Constitution onChanged={changed} />
			{:else}
				<RubricView />
			{/if}
		{/key}
	</div>
</div>

<style>
	.alignment {
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
		.alignment {
			padding: 0.75rem 0.85rem;
		}
	}
</style>
