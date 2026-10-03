<script lang="ts">
	/**
	 * The box a message is written in, shared by Chat and Code.
	 *
	 * Each page used to carry its own copy, and about two thirds of the logic was
	 * identical line for line. The copies had still drifted: Code's options row
	 * did not wrap, its chips were a size smaller, its Send never said why it was
	 * greyed, and its Stop was named differently. What a message is and where it
	 * goes stays with the page (`onsend`); staging files, the box itself and
	 * Send/Stop live here.
	 */
	import type { Snippet } from 'svelte';
	import { ATTACHMENT_ACCEPT, attachmentIcon, screenFiles } from '$lib/attachment-types';
	import { carriesFiles, filesFrom, nameArrival } from '$lib/composer-files';
	import type { AttachmentRef } from '$lib/composer-upload';
	import { autoresize } from '$lib/autoresize';
	import { hasFinePointer } from '$lib/pointer';

	interface Props {
		text: string;
		files: File[];
		uploaded: AttachmentRef[];
		placeholder: string;
		canSend: boolean;
		streaming: boolean;
		stopping: boolean;
		/** Said above the box when a staged image will not be read as it is. */
		visionWarning?: string | null;
		onsend: () => void;
		onstop: () => void;
		/** Every keystroke, so the page can park the draft against its thread. */
		oninput?: () => void;
		/** Files refused by type or size, as one sentence each; null clears. */
		onreject: (reasons: string | null) => void;
		/** Jump-to-latest and the minimised question bar, which belong to the page. */
		top?: Snippet;
		/** The page's own controls, after the paperclip. */
		options?: Snippet;
	}

	let {
		text = $bindable(),
		files = $bindable(),
		uploaded = $bindable(),
		placeholder,
		canSend,
		streaming,
		stopping,
		visionWarning = null,
		onsend,
		onstop,
		oninput,
		onreject,
		top,
		options
	}: Props = $props();

	let fileInput: HTMLInputElement | null = $state(null);

	function accept(incoming: File[]) {
		const { accepted, rejected } = screenFiles(incoming);
		if (accepted.length) files = [...files, ...accepted];
		onreject(rejected.length ? rejected.join(' ') : null);
	}

	function onPicked(ev: Event) {
		const target = ev.target as HTMLInputElement;
		accept([...(target.files ?? [])]);
		target.value = '';
	}

	/**
	 * A screenshot in the clipboard, attached as though it had been picked.
	 *
	 * The paste *event* rather than navigator.clipboard.read(): the async
	 * Clipboard API only exists in a secure context and Galaxy is routinely
	 * served over plain HTTP on a LAN, which is the same reason copyText keeps
	 * its execCommand fallback.
	 */
	function onPaste(ev: ClipboardEvent) {
		const pasted = filesFrom(ev.clipboardData).map((f) => nameArrival(f, new Date()));
		// Only a paste actually carrying a file is ours. Calling preventDefault
		// before this check swallowed every ordinary paste of text into the box.
		if (!pasted.length) return;
		ev.preventDefault();
		accept(pasted);
	}

	/**
	 * Depth, not a boolean: dragleave fires every time the pointer crosses into
	 * a child, so the highlight flickered off over the send button and over each
	 * attachment chip on the way past.
	 */
	let dragDepth = $state(0);

	function onDragEnter(ev: DragEvent) {
		if (!carriesFiles(ev.dataTransfer)) return;
		dragDepth++;
	}

	function onDragOver(ev: DragEvent) {
		if (!carriesFiles(ev.dataTransfer)) return;
		// Without this the browser takes the drop itself and navigates away from
		// the conversation to display the file.
		ev.preventDefault();
		if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
	}

	function onDragLeave(ev: DragEvent) {
		if (!carriesFiles(ev.dataTransfer)) return;
		dragDepth = Math.max(0, dragDepth - 1);
	}

	function onDrop(ev: DragEvent) {
		dragDepth = 0;
		const dropped = filesFrom(ev.dataTransfer).map((f) => nameArrival(f, new Date()));
		if (!dropped.length) return;
		ev.preventDefault();
		accept(dropped);
	}

	/**
	 * Enter sends on a keyboard, and inserts a newline on a touch screen — where
	 * there is no Shift-Enter, so Enter-to-send left no way to write a second
	 * line at all. On touch the send button is the only way to send, which is
	 * what every phone messaging app does.
	 */
	function onKeydown(ev: KeyboardEvent) {
		// Mid-composition Enter commits the IME candidate; it must never send.
		if (ev.key !== 'Enter' || ev.isComposing) return;
		if (ev.shiftKey || !hasFinePointer()) return;
		ev.preventDefault();
		onsend();
	}
</script>

<!-- The whole composer is the drop target, not just the box: a screenshot
     dragged at a two-line textarea mostly misses it. The paperclip stays the
     route that needs no pointer at all. -->
<footer
	class="composer"
	class:dragging={dragDepth > 0}
	ondragenter={onDragEnter}
	ondragover={onDragOver}
	ondragleave={onDragLeave}
	ondrop={onDrop}
>
	{@render top?.()}
	{#if files.length || uploaded.length}
		<div class="pending-files">
			{#each uploaded as ref (ref.id)}
				<span class="att-chip uploaded" title="Uploaded, and sent with your message">
					{attachmentIcon(ref.kind)}
					{ref.name}
					<button
						class="remove"
						aria-label="Remove {ref.name}"
						onclick={() => (uploaded = uploaded.filter((r) => r.id !== ref.id))}>×</button
					>
				</span>
			{/each}
			{#each files as file, i (file.name + i)}
				<span class="att-chip">
					{file.type.startsWith('image/') ? '🖼' : '📄'}
					{file.name}
					<button
						class="remove"
						aria-label="Remove {file.name}"
						onclick={() => (files = files.filter((_, j) => j !== i))}>×</button
					>
				</span>
			{/each}
		</div>
	{/if}
	{#if visionWarning}
		<div class="composer-hint">{visionWarning}</div>
	{/if}
	<div class="composer-row">
		<textarea
			rows="2"
			{placeholder}
			bind:value={text}
			use:autoresize={text}
			oninput={() => oninput?.()}
			onkeydown={onKeydown}
			onpaste={onPaste}
		></textarea>
		{#if streaming}
			<button
				class="btn stop"
				onclick={onstop}
				disabled={stopping}
				title="Stop the run"
				aria-label="Stop the run">{stopping ? '…' : '■'}</button
			>
		{:else}
			<!-- The reason is in the label as well as the title: a title needs a
			     hover, and a phone has none — so the only explanation of why the
			     arrow was greyed was one a thumb could never reach. -->
			<button
				class="btn send"
				onclick={onsend}
				disabled={!canSend}
				title={canSend ? 'Send message' : 'Type a message or attach a file first'}
				aria-label={canSend ? 'Send message' : 'Send message — type something first'}>➤</button
			>
		{/if}
	</div>
	<div class="composer-opts">
		<input
			type="file"
			accept={ATTACHMENT_ACCEPT}
			multiple
			hidden
			bind:this={fileInput}
			onchange={onPicked}
		/>
		<button
			class="chip attach"
			title="Attach images, PDFs, Word docs, markdown or text files"
			aria-label="Attach files"
			onclick={() => fileInput?.click()}>📎</button
		>
		{@render options?.()}
	</div>
</footer>

<style>
	.composer {
		border-top: 1px solid var(--border);
		/* The bottom inset moved to .shell when the tab bar took the bottom of
		   the screen. Two elements both paying env(safe-area-inset-bottom) is a
		   double gap on a notched phone and a wrong one on every other device. */
		padding: 0.7rem 1rem 0.9rem;
		/* Lines the box up with the thread's reading column above it, while the
		   border still spans the pane. */
		padding-inline: max(1rem, calc((100% - var(--thread-measure)) / 2));
	}
	/* Outlined inwards, and an outline rather than a border, so lighting up
	   cannot change the composer's size and shove the thread up a line every
	   time a file passes over it. */
	.composer.dragging {
		outline: 2px dashed var(--accent);
		outline-offset: -4px;
	}
	.pending-files {
		display: flex;
		gap: 0.4rem;
		flex-wrap: wrap;
		margin-bottom: 0.4rem;
	}
	.att-chip {
		display: inline-flex;
		align-items: center;
		gap: 0.2rem;
		background: var(--bg-pane);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		font-size: var(--text-sm);
		padding: 0.15rem 0.4rem;
		margin-top: 0.3rem;
	}
	.att-chip.uploaded {
		border-color: var(--accent);
	}
	.remove {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 1.5rem;
		min-height: var(--tap);
		background: none;
		border: none;
		color: var(--fg-dim);
		cursor: pointer;
		font-size: var(--text-xl);
		line-height: 1;
		padding: 0.2rem;
	}
	.remove:hover {
		color: var(--fg);
	}
	.composer-hint {
		color: var(--fg-dim);
		font-size: var(--text-sm);
		margin-bottom: 0.4rem;
	}
	.composer-row {
		display: flex;
		gap: 0.5rem;
		align-items: flex-end;
	}
	textarea {
		flex: 1;
		box-sizing: border-box;
		background: var(--bg-pane);
		border: 1px solid var(--control-border);
		border-radius: var(--radius);
		color: var(--fg);
		font-family: inherit;
		font-size: var(--text-lg);
		line-height: 1.45;
		padding: 0.6rem 0.8rem;
		/* Grows with the text (see $lib/autoresize) from the two rows it starts
		   at up to roughly eight, then scrolls — so pasting a long brief doesn't
		   leave you typing through a letterbox, and doesn't swallow the thread
		   either. The cap is here rather than in JS so it holds before hydration. */
		max-height: 12rem;
		resize: none;
		overflow-y: auto;
	}
	textarea:focus {
		border-color: var(--accent);
	}
	/* --tap on both axes: on touch the send button is the *only* way to send,
	   since Enter inserts a newline when the pointer is coarse, so a thumb that
	   missed it had no second route and no way to tell a miss from a dead
	   control. It measured 36x33 before. */
	.btn {
		min-width: var(--tap);
	}
	.btn.send {
		background: var(--accent);
		color: var(--bg);
	}
	.btn.stop {
		background: var(--danger);
		color: var(--bg);
	}
	/* Wraps on a narrow screen. Code's copy did not, and its row ran off the
	   right-hand edge of a phone. */
	.composer-opts {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		margin-top: 0.5rem;
		flex-wrap: wrap;
	}
	/* The paperclip is the one chip with no text, and measured 42px wide
	   against a 44px floor. */
	.attach {
		min-width: var(--tap);
		justify-content: center;
	}
</style>
