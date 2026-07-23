<script lang="ts">
	import { marked } from 'marked';
	import DOMPurify from 'dompurify';

	let { text }: { text: string } = $props();
	const html = $derived(
		DOMPurify.sanitize(marked.parse(text, { async: false }) as string)
	);
</script>

<div class="md">{@html html}</div>

<style>
	.md :global(pre) {
		background: var(--bg-pane);
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 0.75rem;
		overflow-x: auto;
		font-size: 0.8rem;
	}
	.md :global(code) {
		font-family: var(--font-mono);
	}
	.md :global(p) {
		margin: 0.4rem 0;
	}
	.md :global(a) {
		color: var(--accent);
	}
	.md :global(table) {
		border-collapse: collapse;
	}
	.md :global(th),
	.md :global(td) {
		border: 1px solid var(--border);
		padding: 0.3rem 0.6rem;
	}
</style>
