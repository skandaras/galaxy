<script lang="ts">
	import type { DiffLine } from '$lib/skill-patch';

	let { lines }: { lines: DiffLine[] } = $props();
</script>

<!-- Marked with + and − as well as colour, so the change still reads for
     someone who cannot tell the two apart. -->
<pre class="diff" aria-label="Proposed change">{#each lines as line, i (i)}{#if line.kind === 'gap'}<span class="gap">⋯ {line.count} unchanged line{line.count === 1 ? '' : 's'}</span>{:else}<span class={line.kind}><span class="mark" aria-hidden="true">{line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '}</span><span class="sr-only">{line.kind === 'add' ? 'added: ' : line.kind === 'del' ? 'removed: ' : ''}</span>{line.text}</span>{/if}
{/each}</pre>

<style>
	.diff {
		margin: 0.4rem 0;
		padding: 0.5rem 0.6rem;
		max-height: 18rem;
		overflow: auto;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		font-family: var(--font-mono);
		font-size: var(--text-sm);
		line-height: 1.5;
		white-space: pre-wrap;
	}
	.mark {
		display: inline-block;
		width: 1.2em;
	}
	.add {
		color: var(--accent);
	}
	.del {
		color: var(--danger);
		text-decoration: line-through;
		text-decoration-thickness: 1px;
	}
	.same,
	.gap {
		color: var(--fg-dim);
	}
	.gap {
		font-style: italic;
	}
</style>
