<script lang="ts">
	/**
	 * The model picker for a thread, one copy for Chat and Code.
	 *
	 * The two said different things when there was nothing to pick. Code's
	 * "No tool-capable models enabled" named no place to fix it.
	 */
	interface ModelOption {
		id: string;
		displayName: string;
		providerName: string;
	}
	interface Props {
		models: ModelOption[];
		value: string;
		/** Why the list might be empty on this page, e.g. "tool-capable". */
		kind?: string;
	}
	let { models, value = $bindable(), kind }: Props = $props();
</script>

<select class="model-select" bind:value aria-label="Model" title="Model for this conversation">
	{#if !models.length}
		<option value="">No {kind ? `${kind} ` : ''}models: add one in Admin → Models</option>
	{/if}
	{#each models as model (model.id)}
		<option value={model.id}>{model.displayName} · {model.providerName}</option>
	{/each}
</select>

<style>
	.model-select {
		background: var(--bg-pane);
		border: 1px solid var(--control-border);
		border-radius: var(--radius);
		color: var(--fg);
		font-family: inherit;
		font-size: var(--text-base);
		padding: 0.3rem 0.4rem;
		max-width: 16rem;
		min-width: 0;
	}
</style>
