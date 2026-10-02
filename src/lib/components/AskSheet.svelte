<script lang="ts">
	import { ATTACHMENT_ACCEPT, attachmentIcon, screenFiles } from '$lib/attachment-types';

	/**
	 * The drawer an agent uses to ask something mid-turn. Shared by chat, coding
	 * and the board hand-off, because it is the same interruption in all three:
	 * the run is parked until this is answered.
	 */
	interface Props {
		prompt: string;
		options?: string[];
		/** The chat the run belongs to, which is where attached files are uploaded. */
		chatId: string;
		/**
		 * Answering resolves the waiting tool call server-side. Resolves false
		 * when the answer did not get there and it is still this person's turn —
		 * which is the difference between a sheet that can be retried and the one
		 * this used to be, stuck on "Sent" with every control disabled after a
		 * single dropped request.
		 */
		onanswer: (answer: string, attachmentIds: string[]) => Promise<boolean>;
		/** Close the question without answering it; the run carries on. */
		onskip: () => Promise<boolean>;
		/**
		 * Tucked away, with AskBar in the composer to bring it back. Hidden
		 * rather than unmounted, so a half-written answer and its staged files
		 * are still there when it opens again.
		 */
		minimised?: boolean;
	}
	let {
		prompt,
		options = [],
		chatId,
		onanswer,
		onskip,
		minimised = $bindable(false)
	}: Props = $props();

	interface Uploaded {
		id: string;
		name: string;
		kind?: 'image' | 'document';
	}

	let text = $state('');
	let sending = $state(false);
	let failure = $state<string | null>(null);
	let field = $state<HTMLTextAreaElement | null>(null);
	let fileInput = $state<HTMLInputElement | null>(null);
	let files = $state<File[]>([]);
	/**
	 * Files already uploaded for this answer. Kept so an answer that fails to
	 * reach the run can be retried without uploading, and orphaning, the same
	 * files again — the same reason the composer keeps its uploadedRefs.
	 */
	let uploaded = $state<Uploaded[]>([]);

	const hasFiles = $derived(files.length > 0 || uploaded.length > 0);

	// The sheet appears without warning mid-run, so put the cursor where the
	// answer goes rather than making them find it. Reopening it does the same.
	$effect(() => {
		if (!minimised) field?.focus();
	});

	async function upload(file: File): Promise<Uploaded> {
		const form = new FormData();
		form.append('file', file);
		const res = await fetch(`/api/chats/${chatId}/attachments`, { method: 'POST', body: form });
		if (!res.ok) {
			const err = await res.json().catch(() => ({ message: res.statusText }));
			throw new Error(`${file.name}: ${err.message ?? 'upload failed'}`);
		}
		return res.json();
	}

	async function send(answer: string) {
		const value = answer.trim();
		if ((!value && !hasFiles) || sending) return;
		sending = true;
		failure = null;
		// `sending` used to be set and never cleared, over a caller that swallowed
		// its own errors — so one failed request left the textarea and every
		// option button disabled for good, with nothing said and no way out of the
		// sheet except stopping the whole run.
		try {
			while (files.length) {
				uploaded = [...uploaded, await upload(files[0])];
				files = files.slice(1);
			}
		} catch (err) {
			sending = false;
			failure = err instanceof Error ? err.message : 'Upload failed.';
			return;
		}
		if (await onanswer(value, uploaded.map((u) => u.id))) return;
		sending = false;
		failure = 'That did not reach the run. Your answer is still here — try again.';
	}

	async function skip() {
		if (sending) return;
		sending = true;
		failure = null;
		if (await onskip()) return;
		sending = false;
		failure = 'The skip did not reach the run — try again.';
	}

	function onkeydown(e: KeyboardEvent) {
		// Enter sends, as everywhere else in Galaxy; Shift+Enter is a newline.
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			void send(text);
		}
	}

	function onFilesPicked(ev: Event) {
		const target = ev.target as HTMLInputElement;
		const { accepted, rejected } = screenFiles([...(target.files ?? [])]);
		target.value = '';
		if (accepted.length) files = [...files, ...accepted];
		failure = rejected.length ? rejected.join(' ') : null;
	}
</script>

{#if !minimised}
	<div class="sheet" role="dialog" aria-modal="false" aria-label="The agent has a question">
		<div class="inner">
			<div class="head">
				<p class="who">The agent is asking</p>
				<button
					class="icon-btn"
					aria-expanded="true"
					aria-label="Minimise the question"
					title="Minimise — the run stays parked until you answer or skip"
					onclick={() => (minimised = true)}>▾</button
				>
			</div>
			<p class="prompt">{prompt}</p>

			{#if options.length}
				<div class="options">
					{#each options as option, i (i)}
						<button class="option" disabled={sending} onclick={() => send(option)}>{option}</button>
					{/each}
				</div>
			{/if}

			{#if hasFiles}
				<div class="files">
					{#each uploaded as ref (ref.id)}
						<span class="file uploaded">
							{attachmentIcon(ref.kind)}
							{ref.name}
							<button
								class="remove"
								aria-label="Remove {ref.name}"
								disabled={sending}
								onclick={() => (uploaded = uploaded.filter((u) => u.id !== ref.id))}>×</button
							>
						</span>
					{/each}
					{#each files as file, i (file.name + i)}
						<span class="file">
							{file.type.startsWith('image/') ? '🖼' : '📄'}
							{file.name}
							<button
								class="remove"
								aria-label="Remove {file.name}"
								disabled={sending}
								onclick={() => (files = files.filter((_, j) => j !== i))}>×</button
							>
						</span>
					{/each}
				</div>
			{/if}

			<div class="reply">
				<input
					type="file"
					accept={ATTACHMENT_ACCEPT}
					multiple
					hidden
					bind:this={fileInput}
					onchange={onFilesPicked}
				/>
				<button
					class="btn attach"
					title="Attach images, PDFs, Word docs, markdown or text files"
					aria-label="Attach files to your answer"
					disabled={sending}
					onclick={() => fileInput?.click()}>📎</button
				>
				<textarea
					bind:this={field}
					bind:value={text}
					{onkeydown}
					rows="2"
					disabled={sending}
					placeholder={options.length ? 'Or say something else…' : 'Your answer…'}
				></textarea>
				<div class="actions">
					<button
						class="btn primary"
						disabled={(!text.trim() && !hasFiles) || sending}
						onclick={() => send(text)}
					>
						{sending ? 'Sent' : 'Answer'}
					</button>
					<button
						class="btn"
						disabled={sending}
						title="Close the question without answering; the agent carries on without it"
						onclick={skip}>Skip</button
					>
				</div>
			</div>
			{#if failure}
				<p class="failed" role="alert">{failure}</p>
			{/if}
			<p class="hint">
				The run is parked until you answer or skip. Skip tells the agent to carry on without an
				answer; ▾ tucks this away so you can read the thread or stop the run.
			</p>
		</div>
	</div>
{/if}

<style>
	.sheet {
		position: fixed;
		/* Was inset: auto 0 0 0, which put this on top of the tab bar. It is
		   aria-modal="false" on purpose — the run is parked, the app is not — so
		   it must not cover the way out of the page. */
		inset: auto 0 var(--above-bar) 0;
		z-index: var(--z-sheet);
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
	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
	}
	.who {
		margin: 0 0 0.3rem;
		font-size: var(--text-xs);
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: var(--accent);
	}
	.icon-btn {
		color: var(--accent);
		font-size: var(--text-lg);
		background: transparent;
		border: 1px solid transparent;
		border-radius: 5px;
		font-family: inherit;
		line-height: 1;
		/* A thumb, not a cursor, is what reaches for this on a phone. */
		min-width: 2.25rem;
		min-height: 2.25rem;
		cursor: pointer;
	}
	.icon-btn:hover {
		border-color: var(--accent);
	}
	.prompt {
		margin: 0 0 0.6rem;
		font-size: var(--text-lg);
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
		font-size: var(--text-base);
		padding: 0.25rem 0.7rem;
		cursor: pointer;
	}
	.option:hover:not(:disabled) {
		border-color: var(--accent);
		color: var(--accent);
	}
	.files {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
		margin-bottom: 0.5rem;
	}
	.file {
		display: inline-flex;
		align-items: center;
		gap: 0.2rem;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 4px;
		font-size: var(--text-sm);
		padding: 0.15rem 0.4rem;
	}
	.file.uploaded {
		border-color: var(--accent);
	}
	.remove {
		background: transparent;
		border: none;
		color: var(--fg-dim);
		font-family: inherit;
		cursor: pointer;
		padding: 0 0.15rem;
	}
	.reply {
		display: flex;
		gap: 0.4rem;
		align-items: flex-end;
	}
	.actions {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}
	textarea {
		flex: 1;
		min-width: 0;
		background: var(--bg);
		border: 1px solid var(--control-border);
		border-radius: var(--radius);
		color: var(--fg);
		font-family: inherit;
		font-size: var(--text-md);
		line-height: 1.5;
		padding: 0.4rem 0.5rem;
		resize: none;
	}
	.hint {
		margin: 0.4rem 0 0;
		font-size: var(--text-sm);
		color: var(--fg-dim);
	}
	.failed {
		margin: 0.4rem 0 0;
		font-size: var(--text-sm);
		color: var(--danger);
	}
	.btn {
		background: var(--border);
		color: var(--fg);
		border: none;
		border-radius: 5px;
		padding: 0.45rem 0.9rem;
		font-family: inherit;
		font-size: var(--text-base);
		cursor: pointer;
	}
	.btn.primary {
		background: var(--accent);
		color: var(--bg);
	}
	.btn.attach {
		padding: 0.45rem 0.6rem;
	}
	.btn:disabled,
	.option:disabled,
	.remove:disabled {
		opacity: 0.5;
		cursor: default;
	}
</style>
