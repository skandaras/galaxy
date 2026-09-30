<script lang="ts">
	/**
	 * What is left of the question sheet once it is minimised: one line at the
	 * top of the composer that opens it again.
	 *
	 * Inside the composer rather than floating, because a fixed bar had nowhere
	 * safe to go. Above the composer it clipped the Stop button whenever the box
	 * grew; at the top of the screen it sat under the header on a phone.
	 */
	interface Props {
		prompt: string;
		onopen: () => void;
	}
	let { prompt, onopen }: Props = $props();
</script>

<button class="ask-bar" aria-expanded="false" onclick={onopen}>
	<span class="who">The agent is asking</span>
	<span class="prompt">{prompt}</span>
	<span class="chevron" aria-hidden="true">▴</span>
</button>

<style>
	.ask-bar {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		width: 100%;
		box-sizing: border-box;
		margin-bottom: 0.4rem;
		background: var(--bg-pane);
		border: 1px solid var(--accent);
		border-radius: 8px;
		color: var(--fg);
		font-family: inherit;
		font-size: var(--text-base);
		padding: 0.45rem 0.75rem;
		cursor: pointer;
		text-align: left;
	}
	.who {
		flex-shrink: 0;
		font-size: var(--text-xs);
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: var(--accent);
	}
	.prompt {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.chevron {
		color: var(--accent);
	}
</style>
