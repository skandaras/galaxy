<script lang="ts">
	import DOMPurify from 'dompurify';

	let { code }: { code: string } = $props();

	/**
	 * Model-authored markup, so it is sanitised before it goes anywhere near the
	 * DOM — scripts, event handlers and foreign objects all stripped. Same
	 * DOMPurify the markdown renderer already runs on every reply, in its SVG
	 * profile.
	 */
	const clean = $derived(
		DOMPurify.sanitize(code, {
			USE_PROFILES: { svg: true, svgFilters: true },
			// An <svg> is the whole point here; without this the wrapper is
			// stripped and only its children survive.
			ADD_TAGS: ['svg']
		})
	);
	/** Sanitising away everything means this was never a drawing. */
	const empty = $derived(!clean.trim());
</script>

{#if empty}
	<pre class="fallback">{code}</pre>
{:else}
	<div class="drawing">{@html clean}</div>
{/if}

<style>
	/* Framed like MermaidBlock's diagram, so the two read as the same kind of
	   thing in a reply. */
	.drawing {
		background: var(--bg-pane);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 0.8rem;
		margin: 0.4rem 0;
		overflow-x: auto;
	}
	.drawing :global(svg) {
		max-width: 100%;
		height: auto;
	}
	.fallback {
		font-family: var(--font-mono);
		background: var(--bg-pane);
		border: 1px solid var(--danger);
		border-radius: 8px;
		padding: 0.7rem;
		font-size: var(--text-base);
		overflow-x: auto;
	}
</style>
