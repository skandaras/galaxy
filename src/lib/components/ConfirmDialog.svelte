<script lang="ts">
	/**
	 * The one host for `ask()` (see $lib/confirm.svelte), mounted in the layout.
	 *
	 * A native <dialog> opened with showModal(), because that is the only way in
	 * this tree to get a real modal: focus is held inside, the page behind goes
	 * inert, Escape cancels, and it draws in the top layer above every z-index
	 * the app defines. The sheets and popovers elsewhere do none of that.
	 */
	import { question } from '$lib/confirm.svelte';

	let dialog = $state<HTMLDialogElement>();
	let cancelButton = $state<HTMLButtonElement>();
	let confirmButton = $state<HTMLButtonElement>();

	const q = $derived(question.current);

	$effect(() => {
		if (!dialog) return;
		if (q && !dialog.open) {
			dialog.showModal();
			// On a destructive question Enter must not be the thing that destroys.
			(q.danger ? cancelButton : confirmButton)?.focus();
		} else if (!q && dialog.open) {
			dialog.close();
		}
	});
</script>

<dialog
	bind:this={dialog}
	class="confirm"
	aria-labelledby="confirm-title"
	oncancel={(e) => {
		e.preventDefault();
		question.answer(false);
	}}
	onclick={(e) => {
		// A click on the backdrop lands on the dialog element itself.
		if (e.target === dialog) question.answer(false);
	}}
>
	{#if q}
		<p id="confirm-title" class="title">{q.title}</p>
		{#if q.body}<p class="hint">{q.body}</p>{/if}
		<div class="actions">
			<button class="btn" bind:this={cancelButton} onclick={() => question.answer(false)}>
				Cancel
			</button>
			<button
				class="btn"
				class:danger={q.danger}
				class:primary={!q.danger}
				bind:this={confirmButton}
				onclick={() => question.answer(true)}>{q.confirm}</button
			>
		</div>
	{/if}
</dialog>

<style>
	.confirm {
		background: var(--bg-pane);
		color: var(--fg);
		border: 1px solid var(--control-border);
		border-radius: var(--radius-lg);
		padding: 1.1rem 1.2rem 1rem;
		width: min(26rem, calc(100vw - 2rem));
		box-sizing: border-box;
	}
	.confirm::backdrop {
		background: rgb(0 0 0 / 0.55);
	}
	.title {
		margin: 0 0 0.5rem;
		font-size: var(--text-md);
		color: var(--heading);
	}
	.hint {
		margin: 0 0 0.6rem;
	}
	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
		margin-top: 0.9rem;
	}
</style>
