<script lang="ts">
	import { permissionTitle, type PermissionDecision } from '$lib/permission-prompt';

	/**
	 * The drawer an agent raises before it runs a tool that needs a yes. Same
	 * slot and same parked run as AskSheet, but it takes a choice and nothing
	 * else: there is no text field, so what the person approves is exactly the
	 * call summarised here.
	 */
	interface Props {
		tool: string;
		server?: string;
		/** Plain text from the tool's describe(). Rendered as text, never as markup. */
		summary: string;
		/**
		 * Resolves false when the answer did not reach the run and the request is
		 * still open, so the same four choices can be tried again.
		 */
		ondecide: (decision: PermissionDecision) => Promise<boolean>;
	}
	let { tool, server, summary, ondecide }: Props = $props();

	let busy = $state(false);
	let failure = $state<string | null>(null);
	let sheet = $state<HTMLDivElement | null>(null);

	// Focus lands on the sheet itself, not on a button. A button focused here
	// would be answered by an Enter keypress that was meant for the composer a
	// moment earlier, and this is the one prompt where a stray Enter grants
	// something.
	$effect(() => {
		sheet?.focus();
	});

	async function decide(decision: PermissionDecision) {
		if (busy) return;
		busy = true;
		failure = null;
		if (await ondecide(decision)) return;
		busy = false;
		failure = 'That did not reach the run. Choose again to retry.';
	}
</script>

<!-- No Escape handler on purpose: closing this without choosing would leave the
     run parked on a question nobody can see. -->
<div
	class="sheet glass"
	role="dialog"
	aria-modal="false"
	aria-labelledby="perm-title"
	aria-describedby="perm-summary"
	tabindex="-1"
	bind:this={sheet}
>
	<div class="inner">
		<p class="who">The agent needs permission</p>
		<p class="title" id="perm-title">{permissionTitle(tool, server)}</p>
		{#if summary}
			<p class="summary num" id="perm-summary">{summary}</p>
		{/if}

		<div class="choices">
			<button type="button" class="btn" disabled={busy} onclick={() => decide('once')}
				>Allow once</button
			>
			<button type="button" class="btn" disabled={busy} onclick={() => decide('session')}
				>Allow for this session</button
			>
			<button type="button" class="btn" disabled={busy} onclick={() => decide('always')}
				>Always allow this tool</button
			>
			<button type="button" class="btn danger" disabled={busy} onclick={() => decide('deny')}
				>Deny</button
			>
		</div>
		{#if failure}
			<p class="notice error" role="alert">{failure}</p>
		{/if}
		<p class="hint">
			The run is parked until you choose. A denial is reported to the agent, which carries on
			without that tool. Always-allows are listed, and can be revoked, in Settings.
		</p>
	</div>
</div>

<style>
	.sheet {
		position: fixed;
		/* Clear of the tab bar for the same reason as AskSheet: the run is
		   parked, the app is not. */
		inset: auto 0 var(--above-bar) 0;
		z-index: var(--z-sheet);
		border-top: 1px solid var(--accent);
		box-shadow: var(--shadow-3);
		animation: rise 0.18s ease-out;
	}
	.sheet:focus {
		outline: none;
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
		font-size: var(--text-xs);
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: var(--accent);
	}
	.title {
		margin: 0 0 0.4rem;
		font-size: var(--text-lg);
		line-height: 1.4;
		overflow-wrap: anywhere;
	}
	.summary {
		margin: 0 0 0.7rem;
		padding: 0.4rem 0.6rem;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		font-size: var(--text-base);
		line-height: 1.5;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		/* A long command or diff summary must not push the choices off a phone. */
		max-height: 7rem;
		overflow-y: auto;
	}
	.choices {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
	}
	.hint,
	.notice {
		margin: 0.5rem 0 0;
	}
</style>
