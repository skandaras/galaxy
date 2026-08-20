<script lang="ts">
	import { copyText } from '$lib/clipboard';

	let { code, lang = '' }: { code: string; lang?: string } = $props();

	type State = 'idle' | 'copied' | 'failed';
	let state = $state<State>('idle');
	let resetTimer: ReturnType<typeof setTimeout> | undefined;

	async function copy() {
		const ok = await copyText(code);
		state = ok ? 'copied' : 'failed';
		clearTimeout(resetTimer);
		resetTimer = setTimeout(() => (state = 'idle'), 2000);
	}
</script>

<div class="code-block">
	<div class="controls">
		{#if lang}<span class="lang">{lang}</span>{/if}
		<button
			class="copy"
			class:ok={state === 'copied'}
			class:failed={state === 'failed'}
			onclick={copy}
			title={state === 'failed' ? 'Copy failed' : 'Copy to clipboard'}
			aria-label="Copy code to clipboard"
		>
			{state === 'copied' ? '✓' : state === 'failed' ? '✕' : '⧉'}
		</button>
	</div>
	<pre><code>{code}</code></pre>
</div>

<style>
	.code-block {
		position: relative;
	}
	.controls {
		position: absolute;
		top: 0.3rem;
		right: 0.45rem;
		display: flex;
		align-items: center;
		gap: 0.4rem;
		/* Sits over the scroll area, so don't swallow drag-to-scroll. */
		pointer-events: none;
	}
	.lang {
		color: var(--fg-dim);
		font-size: 0.62rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}
	.copy {
		pointer-events: auto;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 4px;
		color: var(--fg-dim);
		cursor: pointer;
		font-family: inherit;
		font-size: 0.72rem;
		line-height: 1;
		padding: 0.25rem 0.4rem;
		/* Dimmed rather than hidden: the point is that it's discoverable. */
		opacity: 0.5;
		transition: opacity 0.15s, color 0.15s;
	}
	.code-block:hover .copy,
	.copy:focus-visible {
		opacity: 1;
	}
	.copy:hover {
		color: var(--fg);
	}
	.copy.ok {
		opacity: 1;
		color: var(--accent);
		border-color: var(--accent);
	}
	.copy.failed {
		opacity: 1;
		color: var(--danger);
		border-color: var(--danger);
	}
	.code-block pre {
		/* The inner <code> already pins this; the <pre> needs it too, or the
		   scrollbar width and any bare text in the block follow the interface
		   font instead. */
		font-family: var(--font-mono);
		background: var(--bg-pane);
		border: 1px solid var(--border);
		border-radius: 6px;
		/* Top padding reserves a strip for the language label and copy button. */
		padding: 1.85rem 0.75rem 0.75rem;
		overflow-x: auto;
		font-size: 0.8rem;
		margin: 0.4rem 0;
		/* Short snippets still read as a block rather than a tiny sliver. */
		min-width: min(20rem, 100%);
		box-sizing: border-box;
	}
	.code-block code {
		font-family: var(--font-mono);
	}

	/* No hover on touch, so the button stays at full strength there. */
	@media (hover: none) {
		.copy {
			opacity: 1;
		}
	}
</style>
