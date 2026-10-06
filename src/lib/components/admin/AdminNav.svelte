<script lang="ts">
	/**
	 * Admin's sections, grouped. Twelve tabs in a strip wrapped to three rows of
	 * small text on a phone; sixteen sections would have been worse. A list down
	 * the side on a desktop, one grouped select on a phone.
	 *
	 * The section is in the URL, as the tabs were, so Back steps through it and
	 * a section can be linked to.
	 */
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { tabUrl } from '$lib/url-tab';
	import {
		availableSectionLabels,
		availableSections,
		type AdminGroup,
		type AdminSectionLabel
	} from '$lib/admin-sections';

	interface Props {
		active: AdminSectionLabel;
	}
	let { active }: Props = $props();

	const GROUPS: AdminGroup[] = ['Platform', 'Features', 'Operations'];
	const sections = availableSections();
	const labels = availableSectionLabels();
	const inGroup = (g: AdminGroup) => sections.filter((s) => s.group === g);

	const show = (label: AdminSectionLabel) =>
		void goto(tabUrl(page.url.pathname, label, labels), {
			keepFocus: true,
			noScroll: true
		});
</script>

<nav class="admin-nav" aria-label="Admin sections">
	{#each GROUPS as group (group)}
		<div class="group" role="group" aria-label={group}>
			<span class="group-label" aria-hidden="true">{group}</span>
			{#each inGroup(group) as section (section.label)}
				<button
					class="item"
					class:active={active === section.label}
					aria-current={active === section.label ? 'page' : undefined}
					onclick={() => show(section.label)}>{section.label}</button
				>
			{/each}
		</div>
	{/each}
</nav>

<label class="admin-pick">
	<span class="sr-only">Admin section</span>
	<select value={active} onchange={(e) => show(e.currentTarget.value as AdminSectionLabel)}>
		{#each GROUPS as group (group)}
			<optgroup label={group}>
				{#each inGroup(group) as section (section.label)}
					<option value={section.label}>{section.label}</option>
				{/each}
			</optgroup>
		{/each}
	</select>
</label>

<style>
	.admin-nav {
		display: flex;
		flex-direction: column;
		gap: 0.9rem;
		width: 12rem;
		flex-shrink: 0;
	}
	.group {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
	}
	.group-label {
		font-size: var(--text-xs);
		letter-spacing: 0.15em;
		text-transform: uppercase;
		color: var(--label);
		padding: 0 0.6rem 0.2rem;
	}
	.item {
		text-align: left;
		background: none;
		border: none;
		border-radius: var(--radius);
		color: var(--fg-dim);
		font-family: inherit;
		font-size: var(--text-base);
		padding: 0.35rem 0.6rem;
		min-height: var(--tap);
		cursor: pointer;
	}
	.item:hover {
		color: var(--fg);
	}
	.item.active {
		color: var(--fg);
		background: var(--border);
		box-shadow: inset 3px 0 0 var(--accent);
	}
	.admin-pick {
		display: none;
	}
	.admin-pick select {
		width: 100%;
		background: var(--bg-pane);
		border: 1px solid var(--control-border);
		border-radius: var(--radius);
		color: var(--fg);
		font-family: inherit;
		font-size: var(--text-md);
		padding: 0.45rem 0.5rem;
	}
	@media (max-width: 720px) {
		.admin-nav {
			display: none;
		}
		.admin-pick {
			display: block;
			margin-bottom: 0.9rem;
		}
	}
</style>
