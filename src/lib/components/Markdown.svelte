<script lang="ts">
	import { marked } from 'marked';
	import DOMPurify from 'dompurify';
	import MermaidBlock from './MermaidBlock.svelte';
	import CodeBlock from './CodeBlock.svelte';
	import SvgBlock from './SvgBlock.svelte';
	import { segmentMarkdown } from '$lib/markdown-segments';

	let { text }: { text: string } = $props();

	const segments = $derived(segmentMarkdown(text));
	/**
	 * `breaks` is the important one: agents write a line per item and separate
	 * thoughts with a single newline, which plain CommonMark folds into one
	 * paragraph — the wall of prose every reply arrived as.
	 */
	const render = (md: string) =>
		DOMPurify.sanitize(marked.parse(md, { async: false, gfm: true, breaks: true }) as string);
</script>

<div class="md">
	{#each segments as seg, i (i)}
		{#if seg.kind === 'mermaid'}
			<MermaidBlock code={seg.content} />
		{:else if seg.kind === 'svg'}
			<SvgBlock code={seg.content} />
		{:else if seg.kind === 'code'}
			<CodeBlock code={seg.content} lang={seg.lang} />
		{:else}
			{@html render(seg.content)}
		{/if}
	{/each}
</div>

<style>
	/* Fenced blocks are rendered by CodeBlock, which styles its own <pre>; this
	   covers the indented code blocks marked still emits. The :not() keeps it
	   off CodeBlock's markup — without it the two rules tie on specificity and
	   this one wins on source order, flattening CodeBlock's layout. */
	.md :global(pre:not(.code-block *)) {
		font-family: var(--font-mono);
		background: var(--bg-pane);
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 0.75rem;
		overflow-x: auto;
		font-size: var(--text-md);
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
	/* Headings and lists had no rules at all, so they inherited the thread's
	   line-height and ran together with the prose around them — the structure
	   the model wrote was in the markup but invisible on screen. The top margin
	   is the point: it separates a section from what precedes it. */
	.md :global(h2),
	.md :global(h3),
	.md :global(h4) {
		margin: 1rem 0 0.35rem;
		line-height: 1.3;
	}
	/* First heading of a reply sits flush — the message box supplies that gap. */
	.md :global(h2:first-child),
	.md :global(h3:first-child),
	.md :global(h4:first-child) {
		margin-top: 0;
	}
	.md :global(h2) {
		font-size: var(--text-xl);
	}
	.md :global(h3) {
		font-size: var(--text-lg);
	}
	.md :global(h4) {
		font-size: var(--text-md);
		color: var(--fg-dim);
	}
	.md :global(ul),
	.md :global(ol) {
		margin: 0.35rem 0;
		padding-left: 1.25rem;
	}
	.md :global(li) {
		margin: 0.15rem 0;
	}
	/* Nested lists must not double the gap they already inherit from their li. */
	.md :global(li > ul),
	.md :global(li > ol) {
		margin: 0.15rem 0;
	}
	.md :global(blockquote) {
		margin: 0.5rem 0;
		padding-left: 0.7rem;
		border-left: 2px solid var(--border);
		color: var(--fg-dim);
	}
	.md :global(hr) {
		margin: 0.9rem 0;
		border: none;
		border-top: 1px solid var(--border);
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
