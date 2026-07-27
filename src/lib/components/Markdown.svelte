<script lang="ts">
	import { marked } from 'marked';
	import DOMPurify from 'dompurify';
	import MermaidBlock from './MermaidBlock.svelte';
	import CodeBlock from './CodeBlock.svelte';
	import { segmentMarkdown } from '$lib/markdown-segments';

	let { text }: { text: string } = $props();

	const segments = $derived(segmentMarkdown(text));
	const render = (md: string) =>
		DOMPurify.sanitize(marked.parse(md, { async: false }) as string);
</script>

<div class="md">
	{#each segments as seg, i (i)}
		{#if seg.kind === 'mermaid'}
			<MermaidBlock code={seg.content} />
		{:else if seg.kind === 'code'}
			<CodeBlock code={seg.content} lang={seg.lang} />
		{:else}
			{@html render(seg.content)}
		{/if}
	{/each}
</div>

<style>
	/* Fenced blocks are rendered by CodeBlock now; this still covers the
	   indented code blocks marked emits on its own. */
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
