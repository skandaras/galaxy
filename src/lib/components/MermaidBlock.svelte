<script lang="ts">
	import { onMount } from 'svelte';

	let { code }: { code: string } = $props();
	let svg = $state<string | null>(null);
	let failed = $state(false);
	let container: HTMLDivElement;

	onMount(async () => {
		try {
			const mermaid = (await import('mermaid')).default;
			mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict' });
			const id = `mmd-${Math.random().toString(36).slice(2)}`;
			const result = await mermaid.render(id, code, container);
			svg = result.svg;
		} catch {
			failed = true;
		}
	});
</script>

<div bind:this={container} class="mermaid-host" aria-hidden="true"></div>
{#if svg}
	<div class="diagram">{@html svg}</div>
{:else if failed}
	<pre class="fallback">{code}</pre>
{:else}
	<div class="loading">rendering diagram…</div>
{/if}

<style>
	.mermaid-host {
		display: none;
	}
	.diagram {
		background: var(--bg-pane);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 0.8rem;
		margin: 0.4rem 0;
		overflow-x: auto;
	}
	.diagram :global(svg) {
		max-width: 100%;
		height: auto;
	}
	.fallback {
		/* Raw diagram source shown when mermaid fails to render it. */
		font-family: var(--font-mono);
		background: var(--bg-pane);
		border: 1px solid var(--danger);
		border-radius: 8px;
		padding: 0.7rem;
		font-size: var(--text-base);
		overflow-x: auto;
	}
	.loading {
		color: var(--fg-dim);
		font-size: var(--text-base);
		padding: 0.4rem 0;
	}
</style>
