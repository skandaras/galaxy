<script lang="ts">
	/**
	 * The drawer an agent uses to ask something mid-turn. Shared by chat, coding
	 * and the board hand-off, because it is the same interruption in all three:
	 * the run is parked until this is answered.
	 */
	interface Props {
		prompt: string;
		options?: string[];
		/** Answering resolves the waiting tool call server-side. */
		onanswer: (answer: string) => void;
	}
	let { prompt, options = [], onanswer }: Props = $props();

	let text = $state('');
	let sending = $state(false);
	let field = $state<HTMLTextAreaElement | null>(null);

	// The sheet appears without warning mid-run, so put the cursor where the
	// answer goes rather than making them find it.
	$effect(() => {
		field?.focus();
	});

	function send(answer: string) {
		const value = answer.trim();
		if (!value || sending) return;
		sending = true;
		onanswer(value);
	}

	function onkeydown(e: KeyboardEvent) {
		// Enter sends, as everywhere else in Galaxy; Shift+Enter is a newline.
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			send(text);
		}
	}
</script>

<div class="sheet" role="dialog" aria-modal="false" aria-label="The agent has a question">
	<div class="inner">
		<p class="who">The agent is asking</p>
		<p class="prompt">{prompt}</p>

		{#if options.length}
			<div class="options">
				{#each options as option (option)}
					<button class="option" disabled={sending} onclick={() => send(option)}>{option}</button>
				{/each}
			</div>
		{/if}

		<div class="reply">
			<textarea
				bind:this={field}
				bind:value={text}
				{onkeydown}
				rows="2"
				disabled={sending}
				placeholder={options.length ? 'Or say something else…' : 'Your answer…'}
			></textarea>
			<button class="btn primary" disabled={!text.trim() || sending} onclick={() => send(text)}>
				{sending ? 'Sent' : 'Answer'}
			</button>
		</div>
		<p class="hint">The run is waiting on this. It carries on as soon as you answer.</p>
	</div>
</div>

<style>
	.sheet {
		position: fixed;
		inset: auto 0 0 0;
		z-index: 60;
		background: var(--bg-pane);
		border-top: 1px solid var(--accent);
		box-shadow: 0 -8px 24px rgb(0 0 0 / 0.35);
		animation: rise 0.18s ease-out;
	}
	@keyframes rise {
		from {
			transform: translateY(100%);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.sheet {
			animation: none;
		}
	}
	.inner {
		max-width: 44rem;
		margin: 0 auto;
		padding: 0.85rem 1rem 1rem;
	}
	.who {
		margin: 0 0 0.3rem;
		font-size: 0.62rem;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: var(--accent);
	}
	.prompt {
		margin: 0 0 0.6rem;
		font-size: 0.9rem;
		line-height: 1.5;
	}
	.options {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
		margin-bottom: 0.6rem;
	}
	.option {
		background: transparent;
		border: 1px solid var(--border);
		border-radius: 999px;
		color: var(--fg);
		font-family: inherit;
		font-size: 0.75rem;
		padding: 0.25rem 0.7rem;
		cursor: pointer;
	}
	.option:hover:not(:disabled) {
		border-color: var(--accent);
		color: var(--accent);
	}
	.reply {
		display: flex;
		gap: 0.4rem;
		align-items: flex-end;
	}
	textarea {
		flex: 1;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 6px;
		color: var(--fg);
		font-family: inherit;
		font-size: 0.82rem;
		line-height: 1.5;
		padding: 0.4rem 0.5rem;
		resize: none;
	}
	.hint {
		margin: 0.4rem 0 0;
		font-size: 0.66rem;
		color: var(--fg-dim);
	}
	.btn {
		background: var(--border);
		color: var(--fg);
		border: none;
		border-radius: 5px;
		padding: 0.45rem 0.9rem;
		font-family: inherit;
		font-size: 0.76rem;
		cursor: pointer;
	}
	.btn.primary {
		background: var(--accent);
		color: var(--bg);
	}
	.btn:disabled,
	.option:disabled {
		opacity: 0.5;
		cursor: default;
	}
</style>
