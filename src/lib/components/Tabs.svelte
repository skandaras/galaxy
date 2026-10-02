<script lang="ts" generics="T extends string">
	/**
	 * The tab strip Settings, Admin and Alignment each used to draw from their
	 * own identical copy, none of which told a screen reader it was a set of tabs
	 * or which one was selected.
	 *
	 * The selection lives in the URL (see $lib/url-tab), so Back steps through
	 * tabs and a tab can be linked to; this only renders it.
	 */
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { tabFromUrl, tabUrl } from '$lib/url-tab';

	interface Props {
		tabs: readonly T[];
		label: string;
	}
	let { tabs, label }: Props = $props();

	const active = $derived(tabFromUrl(page.url.searchParams, tabs));
	const show = (tab: T) =>
		void goto(tabUrl(page.url.pathname, tab, tabs), { keepFocus: true, noScroll: true });
</script>

<div class="tabs" role="tablist" aria-label={label}>
	{#each tabs as tab (tab)}
		<button role="tab" aria-selected={active === tab} onclick={() => show(tab)}>{tab}</button>
	{/each}
</div>
