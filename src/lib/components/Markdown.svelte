<script lang="ts">
	import { marked } from 'marked';
	import DOMPurify from 'dompurify';
	import MermaidBlock from './MermaidBlock.svelte';

	let { text }: { text: string } = $props();

	interface Segment {
		kind: 'md' | 'mermaid';
		content: string;
	}

	// Split out ```mermaid fences so diagrams render as SVG instead of code.
	function segment(input: string): Segment[] {
		const out: Segment[] = [];
		const re = /```mermaid\n([\s\S]*?)```/g;
		let last = 0;
		for (let m = re.exec(input); m; m = re.exec(input)) {
			if (m.index > last) out.push({ kind: 'md', content: input.slice(last, m.index) });
			out.push({ kind: 'mermaid', content: m[1] });
			last = m.index + m[0].length;
		}
		if (last < input.length) out.push({ kind: 'md', content: input.slice(last) });
		return out;
	}

	const segments = $derived(segment(text));
	const render = (md: string) =>
		DOMPurify.sanitize(marked.parse(md, { async: false }) as string);
</script>

<div class="md">
	{#each segments as seg, i (i)}
		{#if seg.kind === 'mermaid'}
			<MermaidBlock code={seg.content} />
		{:else}
			{@html render(seg.content)}
		{/if}
	{/each}
</div>

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
